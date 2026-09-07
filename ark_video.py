#!/usr/bin/env python3
"""Direct BytePlus Ark generation — Seedance 2.0 Mini (no OpenRouter passthrough).

Same generate_clip() contract as veo.py / openrouter_video.py so server.py can dispatch.

Security posture:
- API key read from ARK_API_KEY env, config.json (keys.ark), or ~/.ark_api_key (0600); never logged.
- Submit/poll URLs hardcoded to https://ark.ap-southeast.bytepluses.com; task id regex-validated
  before interpolation; video downloaded only from *.bytepluses.com https URLs (SSRF guard).
- Response JSON size-capped; video download size-capped and streamed to out_dir only.
- No third-party SDK — plain urllib against Ark's REST API (Ark's SDK is a thin wrapper over it),
  same zero-extra-dependency posture as openrouter_video.py.
"""

import json
import os
import re
import time
from pathlib import Path
from urllib import request as urllib_request
from urllib.error import HTTPError
from urllib.parse import urlparse

import veo  # config_key, extract_frames

API_BASE = "https://ark.ap-southeast.bytepluses.com/api/v3/contents/generations/tasks"  # hardcoded
ALLOWED_DOWNLOAD_HOST_SUFFIX = "bytepluses.com"
TASK_ID_RE = re.compile(r"^[A-Za-z0-9_\-]+$")

# ponytail: resolution/duration range copied from the OpenRouter Seedance 2.0 Mini listing
# (openrouter_video.MODELS['seedance-mini']) — Ark's own doc page doesn't publish per-resolution
# limits for this model id. Adjust once verified live against the direct endpoint.
MODELS = {
    "ark-seedance-mini": {
        "model_id": "dreamina-seedance-2-0-mini-260615",  # verified live in Ark console model detail page
        "name": "Direct - Seedance 2.0 Mini",
        "resolutions": {"480p", "720p"},
        "durations": set(range(4, 16)),
        # billed directly by BytePlus, not OpenRouter's marked-up rate — placeholder until observed;
        # real cost isn't returned by this API, so estimate is the only number the UI ever shows.
        "pricing": {"480p": 0.008, "720p": 0.008},
    },
}

POLL_INTERVAL_S = 10
TIMEOUT_S = 15 * 60
MAX_JSON_BYTES = 1 * 1024 * 1024
MAX_VIDEO_BYTES = 600 * 1024 * 1024


def load_api_key() -> str:
    """Ark key: env → config.json (keys.ark) → ~/.ark_api_key. Raises RuntimeError if absent."""
    key = os.environ.get("ARK_API_KEY", "").strip() or veo.config_key("ark")
    if not key:
        key_file = Path.home() / ".ark_api_key"
        if key_file.is_file():
            key = key_file.read_text().strip()
    if not key:
        raise RuntimeError(
            "No BytePlus Ark key. Add it to config.json (keys.ark), set ARK_API_KEY, "
            "or create ~/.ark_api_key (chmod 600). Get a key at "
            "https://ai.byteplus.com/ark/region:ap-southeast-1/apikey"
        )
    return key


def estimate_cost(engine: str, resolution: str, duration: int) -> float:
    rate = MODELS[engine]["pricing"].get(resolution, 0)
    return round(rate * duration, 4)


def _redact(text: str) -> str:
    """Strip Ark key shapes and Bearer headers from any text relayed to the UI."""
    return re.sub(r"\b[A-Za-z0-9_\-]{20,}\b", "REDACTED", text)


def _api_json(url: str, api_key: str, payload: dict | None = None) -> dict:
    """One JSON request to Ark. POST when payload given, else GET. Size-capped."""
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    req = urllib_request.Request(url, data=data, headers={
        "Content-Type": "application/json",
        "Authorization": f"Bearer {api_key}",
    })
    try:
        with urllib_request.urlopen(req, timeout=120) as r:
            body = r.read(MAX_JSON_BYTES)
    except HTTPError as e:
        detail = _redact(e.read(4096).decode("utf-8", "replace"))
        raise RuntimeError(f"Ark API {e.code}: {detail[:300]}")
    try:
        parsed = json.loads(body.decode("utf-8"))
    except Exception:
        raise RuntimeError("Ark returned non-JSON response")
    return parsed if isinstance(parsed, dict) else {}


def _safe_download_url(raw_url: str) -> str:
    """Allow only https URLs on *.bytepluses.com (SSRF guard on API-returned URLs)."""
    parsed = urlparse(raw_url or "")
    host = (parsed.hostname or "").lower()
    if parsed.scheme != "https" or not (host == ALLOWED_DOWNLOAD_HOST_SUFFIX
                                        or host.endswith("." + ALLOWED_DOWNLOAD_HOST_SUFFIX)):
        raise RuntimeError("Ark returned an unexpected download host")
    return raw_url


def _download(url: str, dest: Path) -> None:
    req = urllib_request.Request(url)   # signed URL — no auth header needed
    with urllib_request.urlopen(req, timeout=300) as r, open(dest, "wb") as f:
        total = 0
        while True:
            chunk = r.read(1024 * 1024)
            if not chunk:
                break
            total += len(chunk)
            if total > MAX_VIDEO_BYTES:
                raise RuntimeError("downloaded video exceeds size cap")
            f.write(chunk)
    if dest.stat().st_size == 0:
        raise RuntimeError("downloaded video is empty")


def _image_data_url(image_path: Path) -> str:
    import base64
    mime = {"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg",
            "webp": "image/webp"}.get(image_path.suffix.lstrip(".").lower(), "image/jpeg")
    return f"data:{mime};base64," + base64.b64encode(image_path.read_bytes()).decode("ascii")


def generate_clip(prompt: str, out_dir: Path, *, engine: str, image_path: Path | None = None,
                  resolution: str = "720p", duration: int = 8, aspect_ratio: str = "16:9",
                  reference_paths: list[Path] | None = None, progress=None) -> dict:
    """Generate one clip via direct BytePlus Ark. Returns meta dict (same shape as veo.generate_clip)."""
    if engine not in MODELS:
        raise ValueError(f"unknown engine {engine!r}")
    spec = MODELS[engine]
    if resolution not in spec["resolutions"]:
        raise ValueError(f"{spec['name']} supports {sorted(spec['resolutions'])} (got {resolution!r})")
    if duration not in spec["durations"]:
        raise ValueError(f"duration must be one of {sorted(spec['durations'])} (got {duration})")
    if aspect_ratio not in ("16:9", "9:16"):
        raise ValueError(f"unknown aspect ratio {aspect_ratio!r}")
    prompt = (prompt or "").strip()
    if not prompt:
        raise ValueError("empty prompt")

    notify = progress or (lambda msg: None)
    api_key = load_api_key()

    content = [{"type": "text", "text": prompt}]
    if image_path is not None:
        image_path = Path(image_path).resolve()
        if not image_path.is_file():
            raise ValueError(f"image not found: {image_path.name}")
        content.append({
            "type": "image_url",
            "image_url": {"url": _image_data_url(image_path)},
            "role": "first_frame",
        })
    elif reference_paths:
        for p in reference_paths[:3]:
            p = Path(p).resolve()
            if not p.is_file():
                raise ValueError(f"reference image not found: {p.name}")
            content.append({
                "type": "image_url",
                "image_url": {"url": _image_data_url(p)},
                "role": "reference_image",
            })

    payload = {
        "model": spec["model_id"],
        "content": content,
        "resolution": resolution,
        "ratio": aspect_ratio,
        "duration": duration,
        "watermark": False,
    }

    notify("submitting")
    task = None
    for attempt in range(4):
        try:
            task = _api_json(API_BASE, api_key, payload)
            break
        except RuntimeError as exc:
            if "429" in str(exc) and attempt < 3:
                wait = 70 * (attempt + 1)
                notify(f"rate-limited, retrying in {wait}s (attempt {attempt + 2}/4)")
                time.sleep(wait)
            else:
                raise
    task_id = str(task.get("id", ""))
    if not TASK_ID_RE.match(task_id):
        raise RuntimeError("Ark returned an invalid task id")
    poll_url = f"{API_BASE}/{task_id}"          # constructed, not trusted from response

    started = time.monotonic()
    status = str(task.get("status", "queued"))
    while status not in ("succeeded", "failed"):
        elapsed = int(time.monotonic() - started)
        if elapsed > TIMEOUT_S:
            raise TimeoutError(f"generation timed out after {elapsed}s")
        notify(f"generating ({elapsed}s)")
        time.sleep(POLL_INTERVAL_S)
        task = _api_json(poll_url, api_key)
        status = str(task.get("status", ""))

    if status == "failed":
        err = task.get("error")
        err = _redact(str(err.get("message") if isinstance(err, dict) else err or "unknown error"))[:300]
        raise RuntimeError(f"generation failed: {err}")

    video_url = ((task.get("content") or {}).get("video_url")
                 or task.get("video_url"))
    if not video_url:
        raise RuntimeError("no video returned (often a safety-filter rejection — rephrase the prompt)")

    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    clip_path = out_dir / "clip.mp4"

    notify("downloading")
    _download(_safe_download_url(str(video_url)), clip_path)

    notify("extracting frames")
    veo.extract_frames(clip_path, out_dir / "frames")

    return {
        "model": spec["model_id"],
        "tier": engine,
        "resolution": resolution,
        "duration": duration,
        "aspectRatio": aspect_ratio,
        "referenceCount": len(reference_paths[:3]) if reference_paths and image_path is None else 0,
        "cost": estimate_cost(engine, resolution, duration),
        "clipPath": "clip.mp4",
        "generationSeconds": int(time.monotonic() - started),
    }


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="Generate a clip via direct BytePlus Ark from the CLI")
    parser.add_argument("--prompt", required=True)
    parser.add_argument("--image", help="optional starting-frame image (omit for text-to-video)")
    parser.add_argument("--engine", choices=MODELS, default="ark-seedance-mini")
    parser.add_argument("--resolution", default="720p")
    parser.add_argument("--duration", type=int, default=8)
    parser.add_argument("--aspect", choices=["16:9", "9:16"], default="16:9")
    parser.add_argument("--out", default="out")
    args = parser.parse_args()
    meta = generate_clip(
        args.prompt, Path(args.out),
        engine=args.engine,
        image_path=Path(args.image) if args.image else None,
        resolution=args.resolution, duration=args.duration,
        aspect_ratio=args.aspect,
        progress=print,
    )
    print(f"done — ${meta['cost']:.2f} — {Path(args.out) / meta['clipPath']}")
