import 'dart:io';

import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';

import '../background_service.dart';
import '../models.dart';
import 'generating_screen.dart';

const _purple = Color(0xFF7C4DFF);

class WizardScreen extends StatefulWidget {
  const WizardScreen({super.key});

  @override
  State<WizardScreen> createState() => _WizardScreenState();
}

class _WizardScreenState extends State<WizardScreen> {
  final _pageController = PageController();
  final _request = VideoRequest();
  final _promptController = TextEditingController();
  int _step = 0;
  static const _titles = ['Script', 'Style', 'References', 'Settings', 'Review'];

  void _goTo(int step) {
    setState(() => _step = step);
    _pageController.animateToPage(step,
        duration: const Duration(milliseconds: 250), curve: Curves.easeOut);
  }

  Future<void> _pickReferenceImages() async {
    final picker = ImagePicker();
    final picked = await picker.pickMultiImage(limit: 3);
    if (picked.isEmpty) return;
    setState(() {
      _request.referenceImages = picked.take(3).map((x) => File(x.path)).toList();
    });
  }

  void _generate() {
    final job = PendingJob(
      prompt: _request.effectivePrompt,
      resolution: _request.resolution,
      aspectRatio: _request.aspectRatio,
      duration: _request.duration,
      referenceImagePaths: _request.referenceImages.map((f) => f.path).toList(),
    );
    Navigator.of(context).pushReplacement(MaterialPageRoute(
      builder: (_) => GeneratingScreen(job: job),
    ));
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Text(_titles[_step]),
        leading: IconButton(
          icon: const Icon(Icons.arrow_back),
          onPressed: () => _step == 0 ? Navigator.of(context).pop() : _goTo(_step - 1),
        ),
      ),
      body: Column(
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 12, 16, 0),
            child: Row(
              children: List.generate(_titles.length, (i) {
                return Expanded(
                  child: Container(
                    height: 3,
                    margin: const EdgeInsets.symmetric(horizontal: 3),
                    color: i <= _step ? _purple : const Color(0xFFEEEEF3),
                  ),
                );
              }),
            ),
          ),
          Expanded(
            child: PageView(
              controller: _pageController,
              physics: const NeverScrollableScrollPhysics(),
              children: [
                _scriptStep(),
                _styleStep(),
                _referencesStep(),
                _settingsStep(),
                _reviewStep(),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _stepScaffold({required Widget child, required VoidCallback onNext, required String cta}) {
    return Padding(
      padding: const EdgeInsets.all(18),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Expanded(child: SingleChildScrollView(child: child)),
          FilledButton(
            onPressed: onNext,
            style: FilledButton.styleFrom(backgroundColor: _purple, minimumSize: const Size.fromHeight(52)),
            child: Text(cta),
          ),
        ],
      ),
    );
  }

  Widget _scriptStep() {
    return _stepScaffold(
      cta: 'Next →',
      onNext: () {
        _request.prompt = _promptController.text.trim();
        if (_request.prompt.isEmpty) {
          ScaffoldMessenger.of(context)
              .showSnackBar(const SnackBar(content: Text('Describe your video first.')));
          return;
        }
        _goTo(1);
      },
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Text('Describe your video', style: TextStyle(fontWeight: FontWeight.w800, fontSize: 13)),
          const SizedBox(height: 8),
          TextField(
            controller: _promptController,
            maxLength: 2000,
            maxLines: 8,
            decoration: const InputDecoration(border: OutlineInputBorder()),
          ),
          Container(
            padding: const EdgeInsets.all(14),
            decoration: BoxDecoration(color: const Color(0xFFF7F7FA), borderRadius: BorderRadius.circular(16)),
            child: const Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text('Tips for better results', style: TextStyle(fontWeight: FontWeight.w800, fontSize: 13)),
                SizedBox(height: 6),
                Text('✓ Be descriptive and specific'),
                Text('✓ Add key actions and camera movement'),
                Text('✓ Keep one clear visual idea'),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _styleStep() {
    return _stepScaffold(
      cta: 'Next →',
      onNext: () => _goTo(2),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Text("What's the visual style?", style: TextStyle(fontSize: 20, fontWeight: FontWeight.w800)),
          const Text('Blended into your prompt text (Seedance has no separate style parameter).',
              style: TextStyle(color: Colors.grey, fontSize: 12)),
          const SizedBox(height: 14),
          Wrap(
            spacing: 10,
            runSpacing: 10,
            children: [
              for (final style in kStyles)
                ChoiceChip(
                  label: Text(style),
                  selected: _request.style == style,
                  selectedColor: const Color(0xFFF1EDFF),
                  onSelected: (_) => setState(() => _request.style = style),
                ),
            ],
          ),
        ],
      ),
    );
  }

  Widget _referencesStep() {
    return _stepScaffold(
      cta: 'Next →',
      onNext: () => _goTo(3),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Text('Reference Images', style: TextStyle(fontSize: 20, fontWeight: FontWeight.w800)),
          const Text('Optional — up to 3 images to keep characters/style consistent.',
              style: TextStyle(color: Colors.grey, fontSize: 13)),
          const SizedBox(height: 14),
          InkWell(
            onTap: _pickReferenceImages,
            child: Container(
              height: 130,
              decoration: BoxDecoration(
                border: Border.all(color: const Color(0xFFB9A8FF), width: 1.5, style: BorderStyle.solid),
                borderRadius: BorderRadius.circular(18),
                color: const Color(0xFFFAF8FF),
              ),
              child: const Center(
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Icon(Icons.add, color: _purple, size: 28),
                    Text('Upload Image', style: TextStyle(color: _purple, fontWeight: FontWeight.w800)),
                  ],
                ),
              ),
            ),
          ),
          const SizedBox(height: 12),
          if (_request.referenceImages.isNotEmpty)
            Wrap(
              spacing: 10,
              runSpacing: 10,
              children: [
                for (final f in _request.referenceImages)
                  ClipRRect(
                    borderRadius: BorderRadius.circular(12),
                    child: Image.file(f, width: 100, height: 100, fit: BoxFit.cover),
                  ),
              ],
            ),
        ],
      ),
    );
  }

  Widget _settingsStep() {
    return _stepScaffold(
      cta: 'Review Video →',
      onNext: () => _goTo(4),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Text('Duration', style: TextStyle(fontWeight: FontWeight.w800, fontSize: 13)),
          const SizedBox(height: 8),
          Wrap(
            spacing: 8,
            children: [
              for (final d in kDurations)
                ChoiceChip(
                  label: Text('${d}s'),
                  selected: _request.duration == d,
                  selectedColor: const Color(0xFFF1EDFF),
                  onSelected: (_) => setState(() => _request.duration = d),
                ),
            ],
          ),
          const SizedBox(height: 18),
          const Text('Aspect Ratio', style: TextStyle(fontWeight: FontWeight.w800, fontSize: 13)),
          const SizedBox(height: 8),
          Wrap(
            spacing: 8,
            children: [
              for (final r in kAspectRatios)
                ChoiceChip(
                  label: Text(r),
                  selected: _request.aspectRatio == r,
                  selectedColor: const Color(0xFFF1EDFF),
                  onSelected: (_) => setState(() => _request.aspectRatio = r),
                ),
            ],
          ),
          const SizedBox(height: 18),
          const Text('Resolution', style: TextStyle(fontWeight: FontWeight.w800, fontSize: 13)),
          const SizedBox(height: 8),
          Wrap(
            spacing: 8,
            children: [
              for (final r in kResolutions)
                ChoiceChip(
                  label: Text(r),
                  selected: _request.resolution == r,
                  selectedColor: const Color(0xFFF1EDFF),
                  onSelected: (_) => setState(() => _request.resolution = r),
                ),
            ],
          ),
          const SizedBox(height: 18),
          Container(
            padding: const EdgeInsets.all(14),
            decoration: BoxDecoration(color: const Color(0xFFF7F7FA), borderRadius: BorderRadius.circular(16)),
            child: const Row(
              children: [
                Icon(Icons.smart_toy, color: _purple),
                SizedBox(width: 10),
                Text('Model: Seedance 2.0 Mini (OpenRouter)', style: TextStyle(fontWeight: FontWeight.w700)),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _reviewStep() {
    return Padding(
      padding: const EdgeInsets.all(18),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Expanded(
            child: ListView(
              children: [
                Card(
                  child: Padding(
                    padding: const EdgeInsets.all(14),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        _summaryRow('Script', _request.prompt),
                        _summaryRow('Style', _request.style),
                        _summaryRow('References', '${_request.referenceImages.length} image(s)'),
                        _summaryRow('Duration', '${_request.duration} seconds'),
                        _summaryRow('Aspect Ratio', _request.aspectRatio),
                        _summaryRow('Model', 'Seedance 2.0 Mini'),
                        _summaryRow('Resolution', _request.resolution),
                      ],
                    ),
                  ),
                ),
              ],
            ),
          ),
          FilledButton(
            onPressed: _generate,
            style: FilledButton.styleFrom(backgroundColor: _purple, minimumSize: const Size.fromHeight(52)),
            child: const Text('Generate Video ✨'),
          ),
        ],
      ),
    );
  }

  Widget _summaryRow(String label, String value) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(width: 100, child: Text(label, style: const TextStyle(fontWeight: FontWeight.w700))),
          Expanded(child: Text(value, textAlign: TextAlign.right)),
        ],
      ),
    );
  }
}
