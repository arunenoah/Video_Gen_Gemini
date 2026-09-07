import 'dart:io';

import 'package:flutter/material.dart';
import 'package:video_player/video_player.dart';

import 'home_screen.dart';

const _purple = Color(0xFF7C4DFF);

class ResultScreen extends StatefulWidget {
  final String clipPath;
  final bool aspectMismatch;
  final String requestedAspectRatio;
  final String actualAspectRatio;
  const ResultScreen({
    super.key,
    required this.clipPath,
    this.aspectMismatch = false,
    this.requestedAspectRatio = '',
    this.actualAspectRatio = '',
  });

  @override
  State<ResultScreen> createState() => _ResultScreenState();
}

class _ResultScreenState extends State<ResultScreen> {
  VideoPlayerController? _controller;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final controller = VideoPlayerController.file(File(widget.clipPath));
      await controller.initialize();
      await controller.setLooping(true);
      await controller.play();
      if (!mounted) return;
      setState(() => _controller = controller);
    } catch (e) {
      if (!mounted) return;
      setState(() => _error = 'Could not load video: $e');
    }
  }

  @override
  void dispose() {
    _controller?.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Your Video')),
      body: Center(
        child: _error != null
            ? Padding(padding: const EdgeInsets.all(24), child: Text(_error!))
            : _controller == null
                ? const CircularProgressIndicator(color: _purple)
                : Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      if (widget.aspectMismatch)
                        Container(
                          margin: const EdgeInsets.only(bottom: 12),
                          padding: const EdgeInsets.all(12),
                          decoration: BoxDecoration(
                            color: const Color(0xFFFFF3E0),
                            borderRadius: BorderRadius.circular(12),
                          ),
                          child: Text(
                            'Requested ${widget.requestedAspectRatio} but OpenRouter returned '
                            '${widget.actualAspectRatio} — Seedance 2.0 Mini doesn\'t always honor aspect ratio.',
                            style: const TextStyle(color: Color(0xFF7A4A00), fontSize: 12),
                          ),
                        ),
                      AspectRatio(
                        aspectRatio: _controller!.value.aspectRatio,
                        child: VideoPlayer(_controller!),
                      ),
                      const SizedBox(height: 16),
                      IconButton(
                        iconSize: 48,
                        color: _purple,
                        icon: Icon(_controller!.value.isPlaying
                            ? Icons.pause_circle
                            : Icons.play_circle),
                        onPressed: () => setState(() {
                          _controller!.value.isPlaying ? _controller!.pause() : _controller!.play();
                        }),
                      ),
                    ],
                  ),
      ),
      floatingActionButton: FloatingActionButton.extended(
        backgroundColor: _purple,
        icon: const Icon(Icons.home),
        label: const Text('Home'),
        onPressed: () => Navigator.of(context).pushAndRemoveUntil(
          MaterialPageRoute(builder: (_) => const HomeScreen()),
          (route) => false,
        ),
      ),
    );
  }
}
