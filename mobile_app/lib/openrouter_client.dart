import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:http/http.dart' as http;
import 'package:path_provider/path_provider.dart';
import 'package:video_player/video_player.dart';

/// Talks to OpenRouter's video API directly from the device.
/// Mirrors VideoGen/openrouter_video.py's generate_clip() contract for the
/// bytedance/seedance-2.0-mini engine — same model slug, same validation,
/// same SSRF guard on the download URL, same key-redaction in errors.
///
/// Security note: the OpenRouter key lives in this device's Keystore-backed
/// secure storage, not on a server. That's a deliberate, disclosed tradeoff —
/// see the conversation this was built from. The base URL below is a
/// compile-time constant, never user-editable, so the app can't be pointed
/// at an attacker host that would harvest the key.
class OpenRouterClient {
  static const _keyStorageKey = 'openrouter_api_key';
  static const _apiBase = 'https://openrouter.ai/api/v1/videos';
  static const _allowedDownloadHost = 'openrouter.ai';
  static const _modelSlug = 'bytedance/seedance-2.0-mini';
  static const _pollInterval = Duration(seconds: 10);
  // ponytail: 15min matched openrouter_video.py's TIMEOUT_S but real seedance-mini
  // jobs (esp. longer durations) have been observed running past that — 30min gives
  // headroom before we give up on a job that's still legitimately processing.
  static const _timeout = Duration(minutes: 30);
  static const _requestTimeout = Duration(seconds: 30);
  static const _maxConsecutivePollErrors = 5;
  static const _storage = FlutterSecureStorage();
  static final _jobIdRe = RegExp(r'^[A-Za-z0-9_-]+$');
  static final _keyRe = RegExp(r'sk-or-[A-Za-z0-9_-]+');
  static const _maxImageBytes = 20 * 1024 * 1024;

  static Future<String?> loadKey() => _storage.read(key: _keyStorageKey);

  static Future<void> saveKey(String key) => _storage.write(key: _keyStorageKey, value: key.trim());

  static Future<void> clearKey() => _storage.delete(key: _keyStorageKey);

  static String _redact(String text) => text.replaceAll(_keyRe, 'REDACTED');

  static String maskKey(String key) {
    if (key.length <= 8) return '••••';
    return '${key.substring(0, 7)}••••${key.substring(key.length - 4)}';
  }

  /// Submits one clip request, polls until done, downloads the result into
  /// app-sandboxed storage. Throws OpenRouterException on any failure.
  /// [onProgress] receives short status strings for the Generating screen.
  static Future<GenerationResult> generateClip({
    required String prompt,
    required String resolution,
    required String aspectRatio,
    required int duration,
    List<File> referenceImages = const [],
    void Function(String status)? onProgress,
    void Function(String jobId)? onJobId,
  }) async {
    final key = await loadKey();
    if (key == null || key.isEmpty) {
      throw OpenRouterException('No OpenRouter key set — add one in Settings.');
    }
    final headers = {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer $key',
    };

    final body = <String, dynamic>{
      'model': _modelSlug,
      'prompt': prompt,
      'duration': duration,
      'resolution': resolution,
      'aspect_ratio': aspectRatio,
    };
    if (referenceImages.isNotEmpty) {
      body['input_references'] = [
        for (final f in referenceImages.take(3))
          {'type': 'image_url', 'image_url': {'url': await _dataUrl(f)}}
      ];
    }

    onProgress?.call('submitting');
    var job = await _postJson(_apiBase, headers, body);
    final jobId = (job['id'] ?? '').toString();
    if (!_jobIdRe.hasMatch(jobId)) {
      throw OpenRouterException('OpenRouter returned an invalid job id');
    }
    onJobId?.call(jobId);

    return _pollAndFinish(
      jobId: jobId,
      headers: headers,
      job: job,
      resolution: resolution,
      aspectRatio: aspectRatio,
      duration: duration,
      onProgress: onProgress,
    );
  }

  /// Resumes an in-flight job by id — used when a previous attempt lost the
  /// connection but the job may still be running server-side. Skips the
  /// submit step entirely so the user isn't charged for a second generation.
  static Future<GenerationResult> resumeClip({
    required String jobId,
    required String resolution,
    required String aspectRatio,
    required int duration,
    void Function(String status)? onProgress,
  }) async {
    final key = await loadKey();
    if (key == null || key.isEmpty) {
      throw OpenRouterException('No OpenRouter key set — add one in Settings.');
    }
    final headers = {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer $key',
    };
    return _pollAndFinish(
      jobId: jobId,
      headers: headers,
      job: const {'status': 'pending'},
      resolution: resolution,
      aspectRatio: aspectRatio,
      duration: duration,
      onProgress: onProgress,
    );
  }

  static Future<GenerationResult> _pollAndFinish({
    required String jobId,
    required Map<String, String> headers,
    required Map<String, dynamic> job,
    required String resolution,
    required String aspectRatio,
    required int duration,
    void Function(String status)? onProgress,
  }) async {
    final pollUrl = '$_apiBase/$jobId';
    final started = DateTime.now();
    var status = (job['status'] ?? 'pending').toString();
    var consecutivePollErrors = 0;
    while (status != 'completed' && status != 'failed') {
      if (DateTime.now().difference(started) > _timeout) {
        throw OpenRouterException(
            'Generation is taking longer than ${_timeout.inMinutes} minutes — '
            'OpenRouter may still finish it, but this app has stopped waiting.');
      }
      onProgress?.call('generating (${DateTime.now().difference(started).inSeconds}s)');
      await Future.delayed(_pollInterval);
      // A slow/long-running job means many polls over many minutes — a single
      // dropped connection or slow-network hiccup shouldn't discard the whole
      // generation. Retry transient failures; only bail after several in a row.
      try {
        job = await _getJson(pollUrl, headers);
        consecutivePollErrors = 0;
      } on OpenRouterException {
        rethrow; // real API error response (bad auth, 4xx) — don't mask it
      } catch (e) {
        consecutivePollErrors++;
        if (consecutivePollErrors > _maxConsecutivePollErrors) {
          throw OpenRouterException(
              'Lost connection to OpenRouter while checking status: ${_redact('$e')}');
        }
        continue;
      }
      status = (job['status'] ?? '').toString();
    }

    if (status == 'failed') {
      final err = _redact((job['error'] ?? 'unknown error').toString());
      throw OpenRouterException('Generation failed: ${err.substring(0, err.length > 300 ? 300 : err.length)}');
    }

    final urls = (job['unsigned_urls'] as List?) ?? const [];
    if (urls.isEmpty) {
      throw OpenRouterException('No video returned (often a safety-filter rejection — rephrase the prompt).');
    }
    final downloadUrl = _safeDownloadUrl(urls.first.toString());

    onProgress?.call('downloading');
    final clipPath = await _download(downloadUrl, headers);

    final usage = (job['usage'] as Map?) ?? {};
    double cost;
    try {
      cost = (usage['cost'] as num).toDouble();
    } catch (_) {
      cost = 0;
    }

    // OpenRouter's job response only ever echoes back what we asked for, not what
    // it actually rendered — it has been observed to silently ignore aspect_ratio
    // for this engine and return 16:9 regardless of the request. Read the real
    // file instead of trusting the request/response metadata.
    final actualAspectRatio = await _detectAspectRatio(clipPath) ?? aspectRatio;

    return GenerationResult(
      clipPath: clipPath,
      resolution: resolution,
      duration: duration,
      aspectRatio: actualAspectRatio,
      requestedAspectRatio: aspectRatio,
      cost: cost,
      generationSeconds: DateTime.now().difference(started).inSeconds,
    );
  }

  /// Returns '9:16' / '16:9' from the downloaded clip's real dimensions, or
  /// null if the file can't be probed (never fail the whole generation over this).
  static Future<String?> _detectAspectRatio(String clipPath) async {
    final controller = VideoPlayerController.file(File(clipPath));
    try {
      await controller.initialize();
      final size = controller.value.size;
      if (size.width <= 0 || size.height <= 0) return null;
      return size.height > size.width ? '9:16' : '16:9';
    } catch (_) {
      return null;
    } finally {
      await controller.dispose();
    }
  }

  static Future<Map<String, dynamic>> _postJson(
      String url, Map<String, String> headers, Map<String, dynamic> body) async {
    final resp = await http
        .post(Uri.parse(url), headers: headers, body: jsonEncode(body))
        .timeout(_requestTimeout);
    return _decodeOrThrow(resp);
  }

  static Future<Map<String, dynamic>> _getJson(String url, Map<String, String> headers) async {
    final resp = await http.get(Uri.parse(url), headers: headers).timeout(_requestTimeout);
    return _decodeOrThrow(resp);
  }

  static Map<String, dynamic> _decodeOrThrow(http.Response resp) {
    if (resp.statusCode >= 400) {
      String detail = resp.body;
      try {
        final data = jsonDecode(resp.body);
        if (data is Map && data['error'] != null) detail = data['error'].toString();
      } catch (_) {}
      throw OpenRouterException('OpenRouter API ${resp.statusCode}: ${_redact(detail).substring(0, detail.length > 300 ? 300 : detail.length)}');
    }
    final decoded = jsonDecode(resp.body);
    return decoded is Map<String, dynamic> ? decoded : {};
  }

  /// SSRF guard — only ever download from openrouter.ai over https, mirroring
  /// openrouter_video.py's _safe_download_url. Never trust the URL blindly.
  static Uri _safeDownloadUrl(String raw) {
    final uri = Uri.tryParse(raw);
    final host = uri?.host.toLowerCase() ?? '';
    final ok = uri != null &&
        uri.scheme == 'https' &&
        (host == _allowedDownloadHost || host.endsWith('.$_allowedDownloadHost'));
    if (!ok) throw OpenRouterException('OpenRouter returned an unexpected download host');
    return uri;
  }

  static Future<String> _download(Uri url, Map<String, String> headers) async {
    final resp = await http.get(url, headers: {'Authorization': headers['Authorization']!});
    if (resp.statusCode >= 400 || resp.bodyBytes.isEmpty) {
      throw OpenRouterException('Failed to download generated video (${resp.statusCode})');
    }
    final dir = await getApplicationDocumentsDirectory();
    final id = DateTime.now().microsecondsSinceEpoch.toString();
    final file = File('${dir.path}/clip_$id.mp4');
    await file.writeAsBytes(resp.bodyBytes);
    return file.path;
  }

  static Future<String> _dataUrl(File f) async {
    final ext = f.path.split('.').last.toLowerCase();
    final mime = {'png': 'image/png', 'jpg': 'image/jpeg', 'jpeg': 'image/jpeg', 'webp': 'image/webp'}[ext] ??
        'image/jpeg';
    final bytes = await f.readAsBytes();
    if (bytes.length > _maxImageBytes) {
      throw OpenRouterException('${f.path.split('/').last} exceeds 20 MB — pick a smaller image.');
    }
    return 'data:$mime;base64,${base64Encode(bytes)}';
  }
}

class GenerationResult {
  final String clipPath;
  final String resolution;
  final int duration;
  final String aspectRatio; // actual, detected from the downloaded file
  final String requestedAspectRatio;
  final double cost;
  final int generationSeconds;

  bool get aspectMismatch => aspectRatio != requestedAspectRatio;

  GenerationResult({
    required this.clipPath,
    required this.resolution,
    required this.duration,
    required this.aspectRatio,
    required this.requestedAspectRatio,
    required this.cost,
    required this.generationSeconds,
  });
}

class OpenRouterException implements Exception {
  final String message;
  OpenRouterException(this.message);
  @override
  String toString() => message;
}
