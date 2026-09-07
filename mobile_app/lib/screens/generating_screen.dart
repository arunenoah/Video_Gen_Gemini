import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_background_service/flutter_background_service.dart';

import '../background_service.dart';
import '../openrouter_client.dart' show OpenRouterException;
import 'result_screen.dart';

const _purple = Color(0xFF7C4DFF);

class GeneratingScreen extends StatefulWidget {
  final PendingJob job;
  const GeneratingScreen({super.key, required this.job});

  @override
  State<GeneratingScreen> createState() => _GeneratingScreenState();
}

class _GeneratingScreenState extends State<GeneratingScreen> {
  String _detail = 'Starting…';
  String? _error;
  StreamSubscription? _updateSub;
  StreamSubscription? _doneSub;

  @override
  void initState() {
    super.initState();
    _attach();
  }

  @override
  void dispose() {
    _updateSub?.cancel();
    _doneSub?.cancel();
    super.dispose();
  }

  /// Starts (or resumes) the job on the background service, then listens for
  /// progress/result. Runs on the service, not this screen, so it keeps going
  /// even if this screen is closed and the app is swiped away — see
  /// background_service.dart.
  ///
  /// Always calls runGenerationJob, even if the service is already running:
  /// the service stays alive (by design) after a prior job finishes, so
  /// "already running" does NOT mean "already working on this job" — it may
  /// just be sitting idle. _onStart's `busy` guard makes a duplicate invoke
  /// for a job that IS genuinely in flight a harmless no-op.
  Future<void> _attach() async {
    final service = FlutterBackgroundService();
    try {
      await runGenerationJob(widget.job);
    } catch (e) {
      if (mounted) setState(() => _error = e is OpenRouterException ? e.message : '$e');
      return;
    }

    _updateSub = service.on('update').listen((event) {
      final status = event?['status'] as String?;
      if (status != null && mounted) setState(() => _detail = status);
    });

    _doneSub = service.on('done').listen((event) {
      if (!mounted || event == null) return;
      if (event['ok'] == true) {
        Navigator.of(context).pushReplacement(
          MaterialPageRoute(
            builder: (_) => ResultScreen(
              clipPath: event['clipPath'] as String,
              aspectMismatch: event['aspectMismatch'] as bool? ?? false,
              requestedAspectRatio: event['requestedAspectRatio'] as String? ?? '',
              actualAspectRatio: event['actualAspectRatio'] as String? ?? '',
            ),
          ),
        );
      } else {
        setState(() => _error = event['error'] as String? ?? 'Generation failed');
      }
    });
  }

  /// Reloads the persisted job first — the service fills in `jobId` as soon as
  /// the initial submit succeeds, so a retry after that point must resume the
  /// existing job, not resubmit widget.job's stale (jobId-less) copy.
  Future<void> _retry() async {
    final latest = await loadPendingJob() ?? widget.job;
    try {
      await runGenerationJob(latest);
    } catch (e) {
      if (mounted) setState(() => _error = e is OpenRouterException ? e.message : '$e');
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Generating')),
      body: Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              if (_error == null) ...[
                const SizedBox(
                  width: 64,
                  height: 64,
                  child: CircularProgressIndicator(strokeWidth: 5, color: _purple),
                ),
                const SizedBox(height: 24),
                Text(_detail, textAlign: TextAlign.center),
                const SizedBox(height: 8),
                const Text('Running in the background — you can close the app and it keeps going.',
                    style: TextStyle(color: Colors.grey), textAlign: TextAlign.center),
              ] else ...[
                const Icon(Icons.error_outline, color: Colors.red, size: 48),
                const SizedBox(height: 16),
                Text(_error!, textAlign: TextAlign.center),
                const SizedBox(height: 8),
                const Text('The job may still be running on OpenRouter — retry checks it '
                    'instead of starting a new (and separately charged) generation.',
                    style: TextStyle(color: Colors.grey, fontSize: 12), textAlign: TextAlign.center),
                const SizedBox(height: 20),
                Row(
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    OutlinedButton(
                      onPressed: () => Navigator.of(context).pop(),
                      child: const Text('Back'),
                    ),
                    const SizedBox(width: 12),
                    FilledButton(
                      onPressed: () {
                        setState(() {
                          _error = null;
                          _detail = 'Reconnecting…';
                        });
                        _retry();
                      },
                      style: FilledButton.styleFrom(backgroundColor: _purple),
                      child: const Text('Retry'),
                    ),
                  ],
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }
}
