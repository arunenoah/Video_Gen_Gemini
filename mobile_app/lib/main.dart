import 'package:flutter/material.dart';

import 'background_service.dart';
import 'screens/home_screen.dart';

void main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await initBackgroundService();
  runApp(const MyApp());
}

class MyApp extends StatelessWidget {
  const MyApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'AI Video Generator',
      theme: ThemeData(colorScheme: ColorScheme.fromSeed(seedColor: const Color(0xFF7C4DFF))),
      home: const HomeScreen(),
    );
  }
}
