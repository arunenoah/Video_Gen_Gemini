import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:ui';

import 'package:flutter_background_service/flutter_background_service.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'history_store.dart';
import 'openrouter_client.dart';

/// Runs video generation as an Android foreground service so a job keeps
/// getting checked (and a notification fires when it's done) even if the
/// user closes/swipes away the app — `stopWithTask="false"` on the service
/// (set by the flutter_background_service plugin's own manifest) is what
/// keeps it alive through that. Only a true Force Stop or reboot ends it,
/// same as it would for any Android app.
const _channelId = 'video_generation';
const _progressNotificationId = 4200;
const _resultNotificationId = 4201;
const _pendingJobKey = 'vg_pending_job';

final _notifications = FlutterLocalNotificationsPlugin();

Future<void> initBackgroundService() async {
  const channel = AndroidNotificationChannel(
    _channelId,
    'Video generation',
    description: 'Progress while your video generates, and the result when it finishes.',
    importance: Importance.low,
  );
  final androidPlugin =
      _notifications.resolvePlatformSpecificImplementation<AndroidFlutterLocalNotificationsPlugin>();
  await androidPlugin?.createNotificationChannel(channel);
  await androidPlugin?.requestNotificationsPermission();

  await FlutterBackgroundService().configure(
    androidConfiguration: AndroidConfiguration(
      onStart: _onStart,
      autoStart: false,
      isForegroundMode: true,
      notificationChannelId: _channelId,
      initialNotificationTitle: 'Video Generator',
      initialNotificationContent: 'Idle',
      foregroundServiceNotificationId: _progressNotificationId,
    ),
    iosConfiguration: IosConfiguration(),
  );
}

/// One generation job's params — persisted so it survives the app/service
/// process being killed and can be resumed (via [jobId]) on next launch.
class PendingJob {
  final String? jobId; // null until the initial submit succeeds
  final String prompt;
  final String resolution;
  final String aspectRatio;
  final int duration;
  final List<String> referenceImagePaths;

  PendingJob({
    this.jobId,
    required this.prompt,
    required this.resolution,
    required this.aspectRatio,
    required this.duration,
    this.referenceImagePaths = const [],
  });

  PendingJob withJobId(String id) => PendingJob(
        jobId: id,
        prompt: prompt,
        resolution: resolution,
        aspectRatio: aspectRatio,
        duration: duration,
        referenceImagePaths: referenceImagePaths,
      );

  Map<String, dynamic> toJson() => {
        'jobId': jobId,
        'prompt': prompt,
        'resolution': resolution,
        'aspectRatio': aspectRatio,
        'duration': duration,
        'referenceImagePaths': referenceImagePaths,
      };

  factory PendingJob.fromJson(Map<dynamic, dynamic> j) => PendingJob(
        jobId: j['jobId'] as String?,
        prompt: j['prompt'] as String? ?? '',
        resolution: j['resolution'] as String? ?? '720p',
        aspectRatio: j['aspectRatio'] as String? ?? '16:9',
        duration: j['duration'] as int? ?? 8,
        referenceImagePaths: (j['referenceImagePaths'] as List?)?.cast<String>() ?? const [],
      );
}

Future<void> _savePendingJob(PendingJob job) async {
  final prefs = await SharedPreferences.getInstance();
  await prefs.setString(_pendingJobKey, jsonEncode(job.toJson()));
}

/// A leftover job means a previous run never reached completion (killed
/// mid-generation) — surfaced by HomeScreen so the user can resume it.
Future<PendingJob?> loadPendingJob() async {
  final prefs = await SharedPreferences.getInstance();
  final raw = prefs.getString(_pendingJobKey);
  if (raw == null) return null;
  return PendingJob.fromJson(jsonDecode(raw) as Map<String, dynamic>);
}

Future<void> clearPendingJob() async {
  final prefs = await SharedPreferences.getInstance();
  await prefs.remove(_pendingJobKey);
}

/// Starts the foreground service if it isn't already running, and asks it to
/// work on [job] — a fresh submit if `jobId` is null, otherwise a resume.
Future<void> runGenerationJob(PendingJob job) async {
  await _savePendingJob(job);
  final service = FlutterBackgroundService();
  // The Android ServiceRecord can outlive its Dart isolate (killed under
  // memory pressure while idle, or just slow to boot after a cold
  // startService()) — 'generate' sent before the isolate's listener is
  // attached is silently dropped and the UI sits on "Starting…" forever.
  // Ping-and-wait covers both: an already-running-but-stale service, and a
  // freshly started one still booting — no fixed delay to guess wrong on.
  if (await service.isRunning()) {
    if (!await _waitUntilResponsive(service)) {
      service.invoke('stopService');
      await Future.delayed(const Duration(milliseconds: 300));
      await service.startService();
      if (!await _waitUntilResponsive(service)) {
        throw OpenRouterException(
            'Could not reach the background service after a restart — try again.');
      }
    }
  } else {
    await service.startService();
    if (!await _waitUntilResponsive(service)) {
      throw OpenRouterException(
          'Background service did not start in time — try again.');
    }
  }
  service.invoke('generate', job.toJson());
}

/// Pings the background isolate every [interval] until it replies or
/// [timeout] elapses.
Future<bool> _waitUntilResponsive(
  FlutterBackgroundService service, {
  Duration timeout = const Duration(seconds: 8),
  Duration interval = const Duration(milliseconds: 300),
}) async {
  final completer = Completer<bool>();
  final sub = service.on('pong').listen((_) {
    if (!completer.isCompleted) completer.complete(true);
  });
  final started = DateTime.now();
  while (!completer.isCompleted && DateTime.now().difference(started) < timeout) {
    service.invoke('ping');
    await Future.any([
      completer.future,
      Future.delayed(interval),
    ]);
  }
  if (!completer.isCompleted) completer.complete(false);
  final ok = await completer.future;
  await sub.cancel();
  return ok;
}

@pragma('vm:entry-point')
void _onStart(ServiceInstance service) async {
  DartPluginRegistrant.ensureInitialized();
  var busy = false;

  service.on('stopService').listen((_) => service.stopSelf());
  service.on('ping').listen((_) => service.invoke('pong'));

  service.on('generate').listen((event) async {
    if (event == null || busy) return;
    busy = true;
    try {
      await _run(service, PendingJob.fromJson(event));
    } finally {
      busy = false;
    }
  });
}

Future<void> _run(ServiceInstance service, PendingJob job) async {
  void onProgress(String status) {
    if (service is AndroidServiceInstance) {
      service.setForegroundNotificationInfo(title: 'Generating video…', content: status);
    }
    service.invoke('update', {'status': status});
  }

  try {
    final result = job.jobId == null
        ? await OpenRouterClient.generateClip(
            prompt: job.prompt,
            resolution: job.resolution,
            aspectRatio: job.aspectRatio,
            duration: job.duration,
            referenceImages: job.referenceImagePaths.map((p) => File(p)).toList(),
            onJobId: (id) => _savePendingJob(job.withJobId(id)),
            onProgress: onProgress,
          )
        : await OpenRouterClient.resumeClip(
            jobId: job.jobId!,
            resolution: job.resolution,
            aspectRatio: job.aspectRatio,
            duration: job.duration,
            onProgress: onProgress,
          );

    await HistoryStore.add(HistoryEntry(
      id: DateTime.now().microsecondsSinceEpoch.toString(),
      prompt: job.prompt,
      clipPath: result.clipPath,
      duration: result.duration,
      aspectRatio: result.aspectRatio,
      resolution: result.resolution,
      cost: result.cost,
      createdAt: DateTime.now().toIso8601String(),
    ));
    await clearPendingJob();

    if (result.aspectMismatch) {
      await _notify('Video ready — aspect ratio differs',
          'Requested ${result.requestedAspectRatio}, OpenRouter returned ${result.aspectRatio}. Tap to view.');
    } else {
      await _notify('Video ready', 'Your ${result.duration}s clip finished generating. Tap to view.');
    }
    service.invoke('done', {
      'ok': true,
      'clipPath': result.clipPath,
      'aspectMismatch': result.aspectMismatch,
      'requestedAspectRatio': result.requestedAspectRatio,
      'actualAspectRatio': result.aspectRatio,
    });
  } catch (e) {
    final message = e is OpenRouterException ? e.message : '$e';
    await _notify('Generation failed', message);
    service.invoke('done', {'ok': false, 'error': message});
  } finally {
    if (service is AndroidServiceInstance) {
      service.setForegroundNotificationInfo(title: 'Video Generator', content: 'Idle');
    }
  }
}

Future<void> _notify(String title, String body) async {
  await _notifications.show(
    id: _resultNotificationId,
    title: title,
    body: body,
    notificationDetails: const NotificationDetails(
      android: AndroidNotificationDetails(_channelId, 'Video generation',
          importance: Importance.high, priority: Priority.high),
    ),
  );
}
