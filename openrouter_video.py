#!/usr/bin/env python3
"""OpenRouter video generation — Grok Imagine Video & Seedance 1.5 Pro.

Same generate_clip() contract as veo.py so server.py can dispatch on engine.

Security posture:
- API key read from OPENROUTER_API_KEY env, config.json, or ~/.openrouter_api_key (0600); never logged.
- Submit/poll URLs hardcoded to https://openrouter.ai; job id regex-validated before
  interpolation; video downloaded only from openrouter.ai https URLs (SSRF guard).
- Response JSON size-capped; video download size-capped and streamed to out_dir only.
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

API_BASE = "https://openrouter.ai/api/v1/videos"   # hardcoded — never user-derived
ALLOWED_DOWNLOAD_HOST = "openrouter.ai"
JOB_ID_RE = re.compile(r"^[A-Za-z0-9_\-]+$")

# Engine registry — per-model constraints + USD/second estimates (June 2026 listing).
# Actual cost is taken from the API's usage.cost when present.
MODELS = {
    "grok": {
        "slug": "x-ai/grok-imagine-video",
        "name": "Grok Imagine Video",
        "resolutions": {"480p", "720p"},          # model maxes out at 720p
        "durations": {4, 6, 8},                    # subset valid for this app (model: 1-15s)
        "pricing": {"480p": 0.05, "720p": 0.05},
    },
    "seedance": {
        "slug": "bytedance/seedance-1-5-pro",
        "name": "Seedance 1.5 Pro",
        "resolutions": {"720p", "1080p"},
        "durations": {4, 6, 8},                    # subset valid for this app (model: 4-12s)
        # token-priced: height*width*24/1024 tokens per second
        "pricing": {"720p": 0.024, "1080p": 0.052},
    },
}

POLL_INTERVAL_S = 10
TIMEOUT_S = 15 * 60
MAX_JSON_BYTES = 1 * 1024 * 1024          # poll/submit responses are small JSON
MAX_VIDEO_BYTES = 600 * 1024 * 1024       # hard cap on downloaded clip size


def load_api_key() -> str:
    """OpenRouter key: env → config.json → ~/.openrouter_api_key. Raises RuntimeError if absent."""
    key = os.environ.get("OPENROUTER_API_KEY", "").strip() or veo.config_key("openrouter")
    if not key:
        key_file = Path.home() / ".openrouter_api_key"
        if key_file.is_file():
            key = key_file.read_text().strip()
    if not key:
        raise RuntimeError(
            "No OpenRouter key. Add it to config.json (keys.openrouter), set OPENROUTER_API_KEY, "
            "or create ~/.openrouter_api_key (chmod 600). Get a key at https://openrouter.ai/keys"
        )
    return key


def estimate_cost(engine: str, resolution: str, duration: int) -> float:
    rate = MODELS[engine]["pricing"].get(resolution, 0)
    return round(rate * duration, 4)


def _redact(text: str) -> str:
    """Strip OpenRouter key shapes from any text relayed to the UI."""
    return re.sub(r"\bsk-or-[A-Za-z0-9_\-]+\b", "REDACTED", text)


def _api_json(url: str, api_key: str, payload: dict | None = None) -> dict:
    """One JSON request to OpenRouter. POST when payload given, else GET. Size-capped."""
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
        raise RuntimeError(f"OpenRouter API {e.code}: {detail[:300]}")
    try:
        parsed = json.loads(body.decode("utf-8"))
    except Exception:
        raise RuntimeError("OpenRouter returned non-JSON response")
    return parsed if isinstance(parsed, dict) else {}


def _safe_download_url(raw_url: str) -> str:
    """Allow only https URLs on openrouter.ai (SSRF guard on API-returned URLs)."""
    parsed = urlparse(raw_url or "")
    host = (parsed.hostname or "").lower()
    if parsed.scheme != "https" or (host != ALLOWED_DOWNLOAD_HOST
                                    and not host.endswith("." + ALLOWED_DOWNLOAD_HOST)):
        raise RuntimeError("OpenRouter returned an unexpected download host")
    return raw_url


def _download(url: str, api_key: str, dest: Path) -> None:
    req = urllib_request.Request(url, headers={"Authorization": f"Bearer {api_key}"})
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
                  resolution: str = "720p", duration: int = 8, progress=None) -> dict:
    """Generate one clip via OpenRouter. Returns meta dict (same shape as veo.generate_clip)."""
    if engine not in MODELS:
        raise ValueError(f"unknown engine {engine!r}")
    spec = MODELS[engine]
    if resolution not in spec["resolutions"]:
        raise ValueError(f"{spec['name']} supports {sorted(spec['resolutions'])} (got {resolution!r})")
    if duration not in spec["durations"]:
        raise ValueError(f"duration must be one of {sorted(spec['durations'])} (got {duration})")
    prompt = (prompt or "").strip()
    if not prompt:
        raise ValueError("empty prompt")

    notify = progress or (lambda msg: None)
    api_key = load_api_key()

    payload = {
        "model": spec["slug"],
        "prompt": prompt,
        "duration": duration,
        "resolution": resolution,
        "aspect_ratio": "16:9",
    }
    if image_path is not None:
        image_path = Path(image_path).resolve()
        if not image_path.is_file():
            raise ValueError(f"image not found: {image_path.name}")
        payload["frame_images"] = [{
            "type": "image_url",
            "image_url": {"url": _image_data_url(image_path)},
            "frame_type": "first_frame",
        }]

    # Submit (retry on 429 like the Veo path)
    notify("submitting")
    job = None
    for attempt in range(4):
        try:
            job = _api_json(API_BASE, api_key, payload)
            break
        except RuntimeError as exc:
            if "429" in str(exc) and attempt < 3:
                wait = 70 * (attempt + 1)
                notify(f"rate-limited, retrying in {wait}s (attempt {attempt + 2}/4)")
                time.sleep(wait)
            else:
                raise
    job_id = str(job.get("id", ""))
    if not JOB_ID_RE.match(job_id):
        raise RuntimeError("OpenRouter returned an invalid job id")
    poll_url = f"{API_BASE}/{job_id}"          # constructed, not trusted from response

    started = time.monotonic()
    status = str(job.get("status", "pending"))
    while status not in ("completed", "failed"):
        elapsed = int(time.monotonic() - started)
        if elapsed > TIMEOUT_S:
            raise TimeoutError(f"generation timed out after {elapsed}s")
        notify(f"generating ({elapsed}s)")
        time.sleep(POLL_INTERVAL_S)
        job = _api_json(poll_url, api_key)
        status = str(job.get("status", ""))

    if status == "failed":
        err = _redact(str(job.get("error") or "unknown error"))[:300]
        raise RuntimeError(f"generation failed: {err}")

    urls = job.get("unsigned_urls") or []
    if not urls:
        raise RuntimeError("no video returned (often a safety-filter rejection — rephrase the prompt)")

    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    clip_path = out_dir / "clip.mp4"

    notify("downloading")
    _download(_safe_download_url(str(urls[0])), api_key, clip_path)

    notify("extracting frames")
    veo.extract_frames(clip_path, out_dir / "frames")

    usage = job.get("usage") or {}
    try:
        cost = round(float(usage.get("cost")), 4)
    except (TypeError, ValueError):
        cost = estimate_cost(engine, resolution, duration)

    return {
        "model": spec["slug"],
        "tier": engine,
        "resolution": resolution,
        "duration": duration,
        "cost": cost,
        "clipPath": "clip.mp4",
        "generationSeconds": int(time.monotonic() - started),
    }


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="Generate a clip via OpenRouter from the CLI")
    parser.add_argument("--prompt", required=True)
    parser.add_argument("--image", help="optional starting-frame image (omit for text-to-video)")
    parser.add_argument("--engine", choices=MODELS, default="grok")
    parser.add_argument("--resolution", default="720p")
    parser.add_argument("--duration", type=int, choices=[4, 6, 8], default=8)
    parser.add_argument("--out", default="out")
    args = parser.parse_args()
    meta = generate_clip(
        args.prompt, Path(args.out),
        engine=args.engine,
        image_path=Path(args.image) if args.image else None,
        resolution=args.resolution, duration=args.duration,
        progress=print,
    )
    print(f"done — ${meta['cost']:.2f} — {Path(args.out) / meta['clipPath']}")
