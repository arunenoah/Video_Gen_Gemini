import 'dart:convert';

import 'package:shared_preferences/shared_preferences.dart';

/// Local generation history — replaces server.py's /api/list now that
/// there's no server. Metadata only (prompt, cost, path); never the API key.
class HistoryEntry {
  final String id;
  final String prompt;
  final String clipPath;
  final int duration;
  final String aspectRatio;
  final String resolution;
  final double cost;
  final String createdAt;

  HistoryEntry({
    required this.id,
    required this.prompt,
    required this.clipPath,
    required this.duration,
    required this.aspectRatio,
    required this.resolution,
    required this.cost,
    required this.createdAt,
  });

  Map<String, dynamic> toJson() => {
        'id': id,
        'prompt': prompt,
        'clipPath': clipPath,
        'duration': duration,
        'aspectRatio': aspectRatio,
        'resolution': resolution,
        'cost': cost,
        'createdAt': createdAt,
      };

  factory HistoryEntry.fromJson(Map<String, dynamic> j) => HistoryEntry(
        id: j['id'] as String,
        prompt: j['prompt'] as String? ?? '',
        clipPath: j['clipPath'] as String,
        duration: j['duration'] as int? ?? 0,
        aspectRatio: j['aspectRatio'] as String? ?? '',
        resolution: j['resolution'] as String? ?? '',
        cost: (j['cost'] as num? ?? 0).toDouble(),
        createdAt: j['createdAt'] as String? ?? '',
      );
}

class HistoryStore {
  static const _key = 'vg_history';

  static Future<List<HistoryEntry>> list() async {
    final prefs = await SharedPreferences.getInstance();
    final raw = prefs.getStringList(_key) ?? [];
    return raw.map((s) => HistoryEntry.fromJson(jsonDecode(s) as Map<String, dynamic>)).toList()
      ..sort((a, b) => b.createdAt.compareTo(a.createdAt));
  }

  static Future<void> add(HistoryEntry entry) async {
    final prefs = await SharedPreferences.getInstance();
    final raw = prefs.getStringList(_key) ?? [];
    raw.add(jsonEncode(entry.toJson()));
    await prefs.setStringList(_key, raw);
  }
}
