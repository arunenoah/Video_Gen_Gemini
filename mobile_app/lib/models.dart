import 'dart:io';

/// Wizard state for one video request. Only fields the seedance-mini
/// engine actually accepts — see VideoGen/openrouter_video.py MODELS['seedance-mini'].
class VideoRequest {
  String prompt = '';
  String style = 'Cinematic';
  List<File> referenceImages = [];
  int duration = 8; // seedance-mini supports 4-15s
  String aspectRatio = '9:16'; // seedance-mini (openrouter path) supports 16:9 / 9:16 only
  String resolution = '720p'; // seedance-mini supports 480p / 720p only, no 1080p

  String get effectivePrompt => '$style style. $prompt'.trim();
}

const kStyles = [
  'Cinematic',
  'Photorealistic',
  'Anime',
  '3D Animation',
  'Fantasy',
  'Watercolor',
];

const kDurations = [4, 5, 6, 8, 10, 12, 15]; // seedance-mini accepts 4-15s (see MODELS['seedance-mini'])
const kAspectRatios = ['9:16', '16:9'];
const kResolutions = ['480p', '720p'];
