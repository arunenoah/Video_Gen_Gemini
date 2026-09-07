import 'package:flutter/material.dart';

import '../background_service.dart';
import '../history_store.dart';
import '../openrouter_client.dart';
import 'generating_screen.dart';
import 'result_screen.dart';
import 'settings_screen.dart';
import 'wizard_screen.dart';

const _purple = Color(0xFF7C4DFF);

class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key});

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  List<HistoryEntry> _items = [];
  bool _loading = true;
  bool _hasKey = false;
  PendingJob? _pendingJob;

  @override
  void initState() {
    super.initState();
    _refresh();
  }

  Future<void> _refresh() async {
    setState(() => _loading = true);
    final items = await HistoryStore.list();
    final key = await OpenRouterClient.loadKey();
    // A leftover pending job means a previous generation was killed (force stop,
    // reboot, crash) before it finished — offer to pick it back up.
    final pending = await loadPendingJob();
    if (!mounted) return;
    setState(() {
      _items = items;
      _hasKey = key != null && key.isNotEmpty;
      _pendingJob = pending;
      _loading = false;
    });
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('AI Video Generator'),
        actions: [
          IconButton(
            icon: const Icon(Icons.settings),
            onPressed: () async {
              await Navigator.of(context).push(MaterialPageRoute(
                builder: (_) => SettingsScreen(onKeySaved: _refresh),
              ));
              _refresh();
            },
          ),
        ],
      ),
      body: RefreshIndicator(
        onRefresh: _refresh,
        child: _loading
            ? const Center(child: CircularProgressIndicator())
            : ListView(
                padding: const EdgeInsets.all(16),
                children: [
                  if (_pendingJob != null)
                    Card(
                      margin: const EdgeInsets.only(bottom: 16),
                      color: const Color(0xFFF1EDFF),
                      child: ListTile(
                        leading: const Icon(Icons.hourglass_top, color: _purple),
                        title: const Text('Unfinished video generation'),
                        subtitle: Text(_pendingJob!.prompt,
                            maxLines: 1, overflow: TextOverflow.ellipsis),
                        trailing: FilledButton(
                          style: FilledButton.styleFrom(backgroundColor: _purple),
                          onPressed: () async {
                            await Navigator.of(context).push(MaterialPageRoute(
                              builder: (_) => GeneratingScreen(job: _pendingJob!),
                            ));
                            _refresh();
                          },
                          child: const Text('Resume'),
                        ),
                      ),
                    ),
                  if (!_hasKey)
                    Container(
                      padding: const EdgeInsets.all(14),
                      margin: const EdgeInsets.only(bottom: 16),
                      decoration: BoxDecoration(
                        color: const Color(0xFFFFF4E5),
                        borderRadius: BorderRadius.circular(14),
                      ),
                      child: const Text(
                        'Add your OpenRouter API key in Settings before generating a video.',
                      ),
                    ),
                  const Text('Recent Projects',
                      style: TextStyle(fontSize: 16, fontWeight: FontWeight.w700)),
                  const SizedBox(height: 8),
                  if (_items.isEmpty)
                    const Padding(
                      padding: EdgeInsets.symmetric(vertical: 24),
                      child: Text('No videos yet — tap "New Video" to make one.',
                          style: TextStyle(color: Colors.grey)),
                    ),
                  for (final item in _items)
                    Card(
                      margin: const EdgeInsets.only(bottom: 10),
                      child: ListTile(
                        leading: const Icon(Icons.movie, color: _purple),
                        title: Text(item.prompt, maxLines: 1, overflow: TextOverflow.ellipsis),
                        subtitle: Text(
                            '${item.duration}s · ${item.aspectRatio} · \$${item.cost.toStringAsFixed(3)}'),
                        onTap: () {
                          Navigator.of(context).push(MaterialPageRoute(
                            builder: (_) => ResultScreen(clipPath: item.clipPath),
                          ));
                        },
                      ),
                    ),
                ],
              ),
      ),
      floatingActionButton: FloatingActionButton.extended(
        backgroundColor: _purple,
        icon: const Icon(Icons.add),
        label: const Text('New Video'),
        onPressed: () async {
          if (!_hasKey) {
            await Navigator.of(context).push(MaterialPageRoute(
              builder: (_) => SettingsScreen(onKeySaved: _refresh),
            ));
            await _refresh();
            if (!_hasKey) return;
          }
          await Navigator.of(context).push(MaterialPageRoute(builder: (_) => const WizardScreen()));
          _refresh();
        },
      ),
    );
  }
}
