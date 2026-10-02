#!/usr/bin/env python3
"""Copy an ALREADY-GENERATED video (and the pictures that went into it) into examples/ so every user can study it.

    ./.venv/bin/python3 tools/bundle_example.py <generation-id> --title "Little Penguin" [--slug little-penguin]
                                                   [--summary "..."] [--shrink] [--force]

Nothing is regenerated and no API is called. The example is a sanitised copy: no owner, no cost, no timestamps, pictures
downscaled to <=1024 px JPEG. Prompts and titles are checked with the same word filter the app uses; review the result
(poster, pictures, prompts) before committing — everything under examples/ is shown to every signed-in user.
"""
import argparse
import hashlib
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import safety  # noqa: E402

SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]{1,60}$")
ASSET_PREFIXES = {"ref": ("character", "Character look"),
                  "src": ("scene", "Scene picture"),
                  "start": ("start", "Start picture"),
                  "source": ("storyboard", "Storyboard")}
IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp"}
ENGINE_LABELS = {"lite": "Veo 3.1 Lite", "fast": "Veo 3.1 Fast", "quality": "Veo 3.1 Quality", "grok": "Grok Imagine",
                 "seedance": "Seedance 2.0 Pro", "seedance-fast": "Seedance 2.0 Fast", "seedance-mini": "Seedance 2.0 Mini",
                 "seedance-2.5": "Seedance 2.5", "ark-seedance-mini": "Seedance 2.0 Mini (direct)"}
MAX_VIDEO_MB = 30


class BundleError(Exception):
    pass


def _meta(path: Path) -> dict:
    try:
        return json.loads((path / "meta.json").read_text())
    except (OSError, ValueError):
        return {}


def _jpeg(src: Path, dest: Path, max_side: int = 1024, quality: int = 85) -> None:
    from PIL import Image
    with Image.open(src) as im:
        im = im.convert("RGB")
        im.thumbnail((max_side, max_side))
        im.save(dest, "JPEG", quality=quality, optimize=True)


def real_aspect(video: Path, fallback: str = "16:9") -> str:
    """The video's actual shape ('1:1' / '16:9' / '9:16'), read with ffprobe — engines follow the start picture, so the
    requested aspect ratio is not always what came out. Falls back to the recorded value without ffprobe."""
    probe = shutil.which("ffprobe")
    if not probe:
        return fallback
    try:
        out = subprocess.run([probe, "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height",
                              "-of", "csv=p=0", str(video)], capture_output=True, text=True, check=True).stdout.strip()
        w, h = (int(x) for x in out.split(",")[:2])
    except (subprocess.CalledProcessError, ValueError):
        return fallback
    ratio = w / h if h else 1
    return "1:1" if 0.85 <= ratio <= 1.18 else ("16:9" if ratio > 1 else "9:16")


def _poster(gen: Path, dest: Path) -> None:
    frames = sorted((gen / "frames").glob("f*.png"))
    if frames:
        _jpeg(frames[len(frames) // 2], dest, 720)
        return
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise BundleError("no preview frames and ffmpeg not found — cannot make a poster picture")
    tmp = dest.with_suffix(".png")
    subprocess.run([ffmpeg, "-y", "-loglevel", "error", "-ss", "1", "-i", str(gen / "clip.mp4"), "-frames:v", "1", str(tmp)], check=True)
    _jpeg(tmp, dest, 720)
    tmp.unlink()


def bundle(gen_dir: Path, out_root: Path, slug: str, title: str, summary: str = "", force: bool = False,
           shrink: bool = False) -> Path:
    """Build out_root/<slug>/ from a finished generation folder. Returns the example folder."""
    gen_dir, out_root = Path(gen_dir), Path(out_root)
    if not SLUG_RE.match(slug):
        raise BundleError("slug must be lowercase letters, digits and dashes (2-61 chars)")
    meta = _meta(gen_dir)
    if meta.get("kind") not in ("story", "clip", "stitch") or meta.get("status") == "partial":
        raise BundleError("not a finished video generation")
    if meta.get("storyId"):
        raise BundleError("this is one clip of a story — bundle the story itself")
    if not (gen_dir / "clip.mp4").is_file():
        raise BundleError("no clip.mp4 in that folder")
    kids = [_meta(gen_dir.parent / cid) for cid in meta.get("sourceIds", [])] or [meta]
    scenes = [{"n": i, "duration": int(k.get("duration") or 0), "prompt": str(k.get("prompt") or "").strip()}
              for i, k in enumerate(kids, 1)]
    if not all(s["prompt"] for s in scenes):
        raise BundleError("a scene has no prompt text — nothing to teach from")
    for label, text in [("title", title), ("summary", summary)] + [(f"scene {s['n']} prompt", s["prompt"]) for s in scenes]:
        hit = safety.local_check(text)
        if hit:
            raise BundleError(f"the safety word list flagged the {label} ({hit}) — not publishing it to every user")
    dest = out_root / slug
    if dest.exists() and not force:
        raise BundleError(f"{dest} already exists (use --force to replace it)")
    if dest.exists():
        shutil.rmtree(dest)
    dest.mkdir(parents=True)
    try:
        video = dest / "clip.mp4"
        if shrink:
            ffmpeg = shutil.which("ffmpeg")
            if not ffmpeg:
                raise BundleError("--shrink needs ffmpeg")
            subprocess.run([ffmpeg, "-y", "-loglevel", "error", "-i", str(gen_dir / "clip.mp4"), "-vf", "scale=-2:'min(720,ih)'",
                            "-c:v", "libx264", "-crf", "28", "-preset", "slow", "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart",
                            str(video)], check=True)
        else:
            shutil.copyfile(gen_dir / "clip.mp4", video)
        if video.stat().st_size > MAX_VIDEO_MB * 1_000_000:
            raise BundleError(f"video is {video.stat().st_size / 1e6:.0f} MB (> {MAX_VIDEO_MB} MB) — rerun with --shrink")
        _poster(gen_dir, dest / "poster.jpg")
        assets, seen = [], {}
        for p in sorted(gen_dir.iterdir()):
            prefix = next((k for k in ASSET_PREFIXES if p.name.startswith(k)), None)
            if prefix and p.is_file() and p.suffix.lower() in IMAGE_EXTS:
                role, label = ASSET_PREFIXES[prefix]
                name = f"asset{len(assets) + 1:02d}.jpg"
                _jpeg(p, dest / name)
                digest = hashlib.sha256((dest / name).read_bytes()).hexdigest()
                if digest in seen:                                # the same picture used twice (e.g. character look = scene 1)
                    (dest / name).unlink()
                    if label not in seen[digest]["label"]:
                        seen[digest]["label"] += f" + {label}"
                    continue
                assets.append({"file": name, "role": role, "label": label})
                seen[digest] = assets[-1]
        (dest / "example.json").write_text(json.dumps({
            "id": slug, "title": title.strip(), "summary": summary.strip(), "kind": meta["kind"],
            "engine": ENGINE_LABELS.get(meta.get("tier"), meta.get("tier") or ""), "resolution": meta.get("resolution", ""),
            "aspect": real_aspect(video, meta.get("aspectRatio", "16:9")), "duration": int(meta.get("duration") or sum(s["duration"] for s in scenes)),
            "scenes": scenes, "assets": assets, "video": "clip.mp4", "poster": "poster.jpg",
        }, indent=2, ensure_ascii=False))
    except Exception:
        shutil.rmtree(dest, ignore_errors=True)               # never leave a half-built example behind
        raise
    return dest


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("generation_id")
    ap.add_argument("--title", required=True)
    ap.add_argument("--slug")
    ap.add_argument("--summary", default="")
    ap.add_argument("--shrink", action="store_true", help="re-encode to 720p H.264 (smaller file)")
    ap.add_argument("--force", action="store_true", help="replace an existing example with the same slug")
    a = ap.parse_args()
    slug = a.slug or re.sub(r"[^a-z0-9]+", "-", a.title.lower()).strip("-")[:60]
    try:
        dest = bundle(ROOT / "generations" / a.generation_id, ROOT / "examples", slug, a.title, a.summary, a.force, a.shrink)
    except BundleError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1
    size = sum(f.stat().st_size for f in dest.iterdir() if f.is_file())
    print(f"Created {dest.relative_to(ROOT)}  ({size / 1e6:.1f} MB, {len(list(dest.glob('asset*.jpg')))} pictures)")
    print("Review poster.jpg, the pictures and the prompts in example.json BEFORE committing — every user will see them.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
