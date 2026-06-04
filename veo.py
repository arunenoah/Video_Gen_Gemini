#!/usr/bin/env python3
"""Core Veo 3.1 generation — importable by server.py and usable as a CLI.

Security posture:
- API key read from GEMINI_API_KEY env or ~/.gemini_api_key (0600); never logged.
- All API traffic via official google-genai SDK (hardcoded Google endpoint).
- Output written only inside the caller-supplied out_dir.
"""

import json
import os
import shutil
import subprocess
import time
from pathlib import Path

CONFIG_PATH = Path(__file__).resolve().parent / "config.json"

MODELS = {
    "lite": "veo-3.1-lite-generate-preview",
    "fast": "veo-3.1-fast-generate-preview",
    "quality": "veo-3.1-generate-preview",
}

# USD per generated second (Gemini API pricing, June 2026)
PRICING = {
    "lite":    {"720p": 0.05, "1080p": 0.08},
    "fast":    {"720p": 0.10, "1080p": 0.12},
    "quality": {"720p": 0.40, "1080p": 0.40},
}

DEFAULT_NEGATIVE = "cartoon outlines, 2D, flat shading, style change, extra characters, distorted faces"
POLL_INTERVAL_S = 10
TIMEOUT_S = 15 * 60


def config_key(name: str) -> str:
    """Read keys.<name> from git-ignored config.json (server-side only, never served)."""
    try:
        cfg = json.loads(CONFIG_PATH.read_text())
        return str((cfg.get("keys") or {}).get(name, "")).strip()
    except Exception:
        return ""


def load_api_key() -> str:
    """Gemini key: env → config.json → ~/.gemini_api_key. Raises RuntimeError if absent."""
    key = os.environ.get("GEMINI_API_KEY", "").strip() or config_key("gemini")
    if not key:
        key_file = Path.home() / ".gemini_api_key"
        if key_file.is_file():
            key = key_file.read_text().strip()
    if not key:
        raise RuntimeError(
            "No API key. Add it to config.json, set GEMINI_API_KEY, or create "
            "~/.gemini_api_key (chmod 600). Get a key at https://aistudio.google.com/apikey"
        )
    return key


def estimate_cost(tier: str, resolution: str, duration: int) -> float:
    return round(PRICING[tier][resolution] * duration, 4)


def generate_clip(prompt: str, out_dir: Path, *, image_path: Path | None = None,
                  tier: str = "lite", resolution: str = "720p", duration: int = 8,
                  progress=None) -> dict:
    """Generate one clip. Returns meta dict. Raises on failure.

    progress: optional callable(str) for status updates.
    """
    if tier not in MODELS:
        raise ValueError(f"unknown tier {tier!r}")
    if resolution not in ("720p", "1080p"):
        raise ValueError(f"unknown resolution {resolution!r}")
    if duration not in (4, 6, 8):
        raise ValueError(f"duration must be 4, 6 or 8 (got {duration})")
    prompt = (prompt or "").strip()
    if not prompt:
        raise ValueError("empty prompt")

    notify = progress or (lambda msg: None)
    os.environ.setdefault("GEMINI_API_KEY", load_api_key())

    from google import genai
    from google.genai import types

    client = genai.Client()
    model = MODELS[tier]

    source_kwargs = {"prompt": prompt}
    if image_path is not None:
        image_path = Path(image_path).resolve()
        if not image_path.is_file():
            raise ValueError(f"image not found: {image_path.name}")
        source_kwargs["image"] = types.Image.from_file(location=str(image_path))

    config_kwargs = {
        "number_of_videos": 1,
        "resolution": resolution,
        "duration_seconds": duration,
    }
    if tier != "lite":  # lite tier rejects negativePrompt (400 INVALID_ARGUMENT)
        config_kwargs["negative_prompt"] = DEFAULT_NEGATIVE

    notify("submitting")
    operation = client.models.generate_videos(
        model=model,
        source=types.GenerateVideosSource(**source_kwargs),
        config=types.GenerateVideosConfig(**config_kwargs),
    )

    started = time.monotonic()
    while not operation.done:
        elapsed = int(time.monotonic() - started)
        if elapsed > TIMEOUT_S:
            raise TimeoutError(f"generation timed out after {elapsed}s")
        notify(f"generating ({elapsed}s)")
        time.sleep(POLL_INTERVAL_S)
        operation = client.operations.get(operation)

    if operation.error:
        raise RuntimeError(f"generation failed: {operation.error}")
    response = operation.response or operation.result
    if not response or not response.generated_videos:
        # Most common cause: safety filter rejection
        raise RuntimeError("no video returned (often a safety-filter rejection — rephrase the prompt)")

    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    clip_path = out_dir / "clip.mp4"

    notify("downloading")
    video = response.generated_videos[0]
    client.files.download(file=video.video)
    video.video.save(str(clip_path))

    notify("extracting frames")
    extract_frames(clip_path, out_dir / "frames")

    return {
        "model": model,
        "tier": tier,
        "resolution": resolution,
        "duration": duration,
        "cost": estimate_cost(tier, resolution, duration),
        "clipPath": "clip.mp4",
        "generationSeconds": int(time.monotonic() - started),
    }


def extract_frames(clip_path: Path, frames_dir: Path, count: int = 6) -> None:
    """Evenly spaced preview/QC frames. Silently skips if ffmpeg is missing."""
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        return
    frames_dir.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        [ffmpeg, "-y", "-loglevel", "error", "-i", str(clip_path),
         "-vf", f"fps={count}/8,scale=640:-2", "-frames:v", str(count),
         str(frames_dir / "f%02d.png")],
        check=False, timeout=120,
    )


def stitch(clip_paths: list[Path], out_path: Path) -> None:
    """Concat clips in order. Tries stream-copy, falls back to re-encode."""
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise RuntimeError("ffmpeg not installed — required for stitching")
    out_path = Path(out_path)
    list_file = out_path.with_suffix(".list.txt")
    list_file.write_text("".join(f"file '{p.resolve()}'\n" for p in clip_paths))
    try:
        copy_cmd = [ffmpeg, "-y", "-loglevel", "error", "-f", "concat", "-safe", "0",
                    "-i", str(list_file), "-c", "copy", str(out_path)]
        result = subprocess.run(copy_cmd, capture_output=True, timeout=300)
        if result.returncode != 0:
            encode_cmd = [ffmpeg, "-y", "-loglevel", "error", "-f", "concat", "-safe", "0",
                          "-i", str(list_file), "-c:v", "libx264", "-crf", "18",
                          "-pix_fmt", "yuv420p", "-c:a", "aac", str(out_path)]
            subprocess.run(encode_cmd, check=True, capture_output=True, timeout=600)
    finally:
        list_file.unlink(missing_ok=True)


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="Generate a Veo 3.1 clip from the CLI")
    parser.add_argument("--prompt", required=True)
    parser.add_argument("--image", help="optional starting-frame image (omit for text-to-video)")
    parser.add_argument("--tier", choices=MODELS, default="lite")
    parser.add_argument("--resolution", choices=["720p", "1080p"], default="720p")
    parser.add_argument("--duration", type=int, choices=[4, 6, 8], default=8)
    parser.add_argument("--out", default="out")
    args = parser.parse_args()
    meta = generate_clip(
        args.prompt, Path(args.out),
        image_path=Path(args.image) if args.image else None,
        tier=args.tier, resolution=args.resolution, duration=args.duration,
        progress=print,
    )
    print(f"done — ${meta['cost']:.2f} — {Path(args.out) / meta['clipPath']}")
