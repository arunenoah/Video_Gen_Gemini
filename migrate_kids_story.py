#!/usr/bin/env python3
"""One-off: import the kids-story pipeline clips into VideoGen's archive.

Copies each clip + the stitched final video from kids-story/pipeline/out/
into generations/<id>/ with a meta.json the app understands, and extracts
preview frames for Library thumbnails.
"""

import json
import shutil
import subprocess
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
SRC = HERE.parent / "kids-story" / "pipeline"
OUT = SRC / "out"
GENERATIONS = HERE / "generations"

CLIPS = [
    # (file stem, prompt file, title, duration, cost)
    ("clip01", "clip01_cold_winter_night.txt", "Clip 1 — Cold Winter Night", 8, 0.40),
    ("clip02", "clip02_mystery.txt",           "Clip 2 — The Mystery", 8, 0.40),
    ("clip03", "clip03_experiment.txt",        "Clip 3 — The Blanket Experiment", 8, 0.40),
    ("clip04", "clip04_air_pockets.txt",       "Clip 4 — Air Pockets", 8, 0.40),
    ("clip05a", "clip05a_sheep.txt",           "Clip 5a — Animal Challenge: Sheep", 6, 0.30),
    ("clip05b", "clip05b_ducks.txt",           "Clip 5b — Animal Challenge: Ducks", 6, 0.30),
    ("clip06", "clip06_blubber.txt",           "Clip 6 — Bonus: Blubber", 8, 0.40),
    ("clip07", "clip07_champion.txt",          "Clip 7 — Science Champion", 8, 0.40),
]


def frames(clip: Path, out_dir: Path) -> None:
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        return
    out_dir.mkdir(parents=True, exist_ok=True)
    subprocess.run([ffmpeg, "-y", "-loglevel", "error", "-i", str(clip),
                    "-vf", "fps=6/8,scale=640:-2", "-frames:v", "6",
                    str(out_dir / "f%02d.png")], check=False, timeout=120)


def import_one(gen_id: str, mp4: Path, meta: dict) -> None:
    dest = GENERATIONS / gen_id
    if dest.exists():
        print(f"skip (exists): {gen_id}")
        return
    dest.mkdir(parents=True)
    shutil.copy2(mp4, dest / "clip.mp4")
    frames(dest / "clip.mp4", dest / "frames")
    meta["id"] = gen_id
    meta["clipPath"] = "clip.mp4"
    meta.setdefault("createdAt",
                    datetime.fromtimestamp(mp4.stat().st_mtime, tz=timezone.utc).isoformat())
    (dest / "meta.json").write_text(json.dumps(meta, indent=2, ensure_ascii=False))
    print(f"imported: {gen_id}  ({meta['duration']}s, ${meta['cost']:.2f})")


def main() -> None:
    GENERATIONS.mkdir(exist_ok=True)
    clip_ids = []
    for stem, prompt_file, title, duration, cost in CLIPS:
        mp4 = OUT / f"{stem}.mp4"
        if not mp4.is_file():
            print(f"missing: {mp4}")
            continue
        prompt_path = SRC / prompt_file
        prompt = f"{title}\n\n" + (prompt_path.read_text() if prompt_path.is_file() else "")
        gen_id = f"20260604-blanket-{stem}"
        clip_ids.append(gen_id)
        import_one(gen_id, mp4, {
            "prompt": prompt.strip(),
            "kind": "clip",
            "tier": "lite",
            "resolution": "720p",
            "duration": duration,
            "cost": cost,
            "hasImage": True,
        })

    final = OUT / "final_video.mp4"
    if final.is_file():
        import_one("20260604-blanket-why-warm-full-story", final, {
            "prompt": "Why Is It Warm Under the Blanket? — full 60s story (7 scenes)",
            "kind": "story",
            "tier": "lite",
            "resolution": "720p",
            "duration": 60,
            "cost": 3.00,
            "sourceIds": clip_ids,
        })


if __name__ == "__main__":
    main()
