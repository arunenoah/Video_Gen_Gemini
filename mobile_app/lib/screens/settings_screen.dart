import 'package:flutter/material.dart';

import '../openrouter_client.dart';

const _purple = Color(0xFF7C4DFF);

class SettingsScreen extends StatefulWidget {
  final VoidCallback onKeySaved;
  const SettingsScreen({super.key, required this.onKeySaved});

  @override
  State<SettingsScreen> createState() => _SettingsScreenState();
}

class _SettingsScreenState extends State<SettingsScreen> {
  final _controller = TextEditingController();
  String? _currentMasked;
  bool _editing = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final key = await OpenRouterClient.loadKey();
    if (!mounted) return;
    setState(() {
      _currentMasked = key != null && key.isNotEmpty ? OpenRouterClient.maskKey(key) : null;
      _editing = _currentMasked == null;
    });
  }

  Future<void> _save() async {
    final value = _controller.text.trim();
    if (value.isEmpty) return;
    await OpenRouterClient.saveKey(value);
    _controller.clear();
    widget.onKeySaved();
    await _load();
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Key saved.')));
  }

  Future<void> _clear() async {
    await OpenRouterClient.clearKey();
    widget.onKeySaved();
    await _load();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Settings')),
      body: Padding(
        padding: const EdgeInsets.all(20),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const Text('OpenRouter API key', style: TextStyle(fontWeight: FontWeight.w800)),
            const SizedBox(height: 6),
            const Text(
              'Stored only on this device (Android Keystore). Never sent anywhere '
              'except as an Authorization header to openrouter.ai.',
              style: TextStyle(color: Colors.grey, fontSize: 12),
            ),
            const SizedBox(height: 16),
            if (!_editing && _currentMasked != null) ...[
              Row(
                children: [
                  Expanded(
                    child: Text(_currentMasked!,
                        style: const TextStyle(fontFamily: 'monospace', fontSize: 16)),
                  ),
                  TextButton(onPressed: () => setState(() => _editing = true), child: const Text('Replace')),
                  TextButton(onPressed: _clear, child: const Text('Remove')),
                ],
              ),
            ] else ...[
              TextField(
                controller: _controller,
                obscureText: true,
                decoration: const InputDecoration(
                  labelText: 'sk-or-...',
                  border: OutlineInputBorder(),
                ),
              ),
              const SizedBox(height: 12),
              FilledButton(
                onPressed: _save,
                style: FilledButton.styleFrom(backgroundColor: _purple, minimumSize: const Size.fromHeight(52)),
                child: const Text('Save key'),
              ),
            ],
            const SizedBox(height: 24),
            const Text('Get a key at openrouter.ai/keys', style: TextStyle(color: Colors.grey, fontSize: 12)),
          ],
        ),
      ),
    );
  }
}
