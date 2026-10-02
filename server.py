#!/usr/bin/env python3
"""SparkGarden local server — threaded HTTP server + Veo job runner + archive.

Security posture:
- Binds 127.0.0.1 only; Host header validated (DNS-rebinding guard).
- API key lives server-side only (env / ~/.gemini_api_key) — never sent to the browser.
- All id params validated against a strict regex (path-traversal guard).
- Upload: MIME allow-list + size cap; request bodies capped.
- ffmpeg invoked with array args only.
- Optional access password (config.json keys.password): HMAC-signed session cookie
  (HttpOnly, SameSite=Strict), login rate-limited, gates every route by default-deny.
  Empty/unset password = auth disabled (matches this app's other optional keys).
"""

import json
import base64
import os
import ipaddress
import posixpath
import re
import shutil
import sys
import threading
import time
import uuid
from datetime import datetime, timedelta, timezone
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from urllib import request as urllib_request
from urllib.error import HTTPError
from urllib.parse import parse_qs, unquote

import veo
import openrouter_video
import openrouter_chat
import ark_video
import auth
import safety

try:                                     # Pillow: crop one clean character reference from the board
    from PIL import Image as _PILImage
    _PILImage.MAX_IMAGE_PIXELS = 50_000_000   # decompression-bomb guard for untrusted uploads
except Exception:                        # optional dep — feature degrades to text-only consistency
    _PILImage = None

try:
    PORT = int(os.environ.get("PORT") or 8767)         # hosting platforms (Render…) tell us which port to use
except ValueError:
    PORT = 8767
# What people see and pay is the provider's real cost × this (business margin). Credits, estimates, final prices and the
# header total are all in these "user" dollars; meta.json on disk keeps the real provider cost. 1 = pass-through.
def startup_warnings(reset_admin: bool, data_dir: Path, data_dir_set: bool, is_mount=os.path.ismount) -> list[str]:
    """Loud, specific log lines for the two setups that make the admin account 'forget' itself between restarts."""
    out = []
    if reset_admin:
        out.append("WARNING: VIDEOGEN_RESET_ADMIN=1 is set — the admin password and 2FA are wiped on EVERY start. "
                   "Use it once to recover, then REMOVE the variable and redeploy.")
    if data_dir_set and not is_mount(str(data_dir)):
        out.append(f"WARNING: {data_dir} is not a separate disk/volume — on most hosts it is wiped on every deploy or restart, "
                   "so users, credits and generated files would be lost. Attach a persistent disk mounted at this path.")
    return out


def parse_price_multiplier(raw) -> float:
    """VIDEOGEN_PRICE_MULTIPLIER → a sane factor: default 5, clamped to 1..100, junk/NaN/inf → default."""
    try:
        v = float(raw or 5)
    except (TypeError, ValueError):
        return 5.0
    return min(100.0, max(1.0, v)) if v == v and v not in (float("inf"), float("-inf")) else 5.0


PRICE_MULTIPLIER = parse_price_multiplier(os.environ.get("VIDEOGEN_PRICE_MULTIPLIER"))
ROOT = Path(__file__).resolve().parent
GENERATIONS = auth.DATA_DIR / "generations"            # same persistent folder as users.db (VIDEOGEN_DATA_DIR)
ID_RE = re.compile(r"^[A-Za-z0-9_\-]+$")
SLUG_RE = re.compile(r"[^a-z0-9]+")
MAX_BODY = 60 * 1024 * 1024          # 60 MB (story mode: several base64 images)
IMAGE_MIMES = {"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp"}
MAX_CLIPS_PER_STITCH = 30
MAX_SCENES = 20
MAX_STORY_IMAGES = 10
MAX_REF_IMAGES = 3                   # character reference images per run (engine caps)
def build_allowed_hosts(port: int, public_hosts: list[str]) -> set[str]:
    """Host headers we accept (DNS-rebinding guard). A public host is accepted with and without the port, because behind
    an HTTPS reverse proxy browsers send just the bare domain."""
    hosts = {f"127.0.0.1:{port}", f"localhost:{port}"}
    for h in public_hosts:
        hosts.update({h, f"{h}:{port}"})
    return hosts


ALLOWED_HOSTS = build_allowed_hosts(PORT, [])
# Opt-in remote access: VIDEOGEN_BIND=0.0.0.0 VIDEOGEN_PUBLIC_HOST=<ip-or-domain>[,<another>]
BIND_ADDR = os.environ.get("VIDEOGEN_BIND", "127.0.0.1")
def parse_public_hosts(raw: str, platform_host: str = "") -> list[str]:
    """VIDEOGEN_PUBLIC_HOST → clean host names. Forgiving about the usual slips (pasted 'https://' or a trailing '/path');
    also trusts the hostname the hosting platform itself injects (Render sets RENDER_EXTERNAL_HOSTNAME)."""
    out: list[str] = []
    for item in [*raw.split(","), platform_host]:
        h = re.sub(r"^[a-z][a-z0-9+.-]*://", "", item.strip().lower()).split("/")[0].split("?")[0].strip()
        if h and re.fullmatch(r"[a-z0-9.:\[\]-]{1,253}", h) and h not in out:      # a plain host[:port] — nothing else
            out.append(h)
    return out


_public_hosts = parse_public_hosts(os.environ.get("VIDEOGEN_PUBLIC_HOST", ""), os.environ.get("RENDER_EXTERNAL_HOSTNAME", ""))
ALLOWED_HOSTS = build_allowed_hosts(PORT, _public_hosts)         # comma-separated: LAN ip, public ip, domain…
# Behind a reverse proxy (Render, Nginx…) every connection comes from the proxy, so rate limits must use the address the
# proxy saw. Only enable this when the app is reachable ONLY through that proxy — the header is client-forgeable otherwise.
TRUST_PROXY = os.environ.get("VIDEOGEN_TRUST_PROXY") == "1"
_REJECTED_HOSTS: set[str] = set()
try:
    PROXY_HOPS = max(1, int(os.environ.get("VIDEOGEN_PROXY_HOPS") or 1))     # trusted proxies in front of us
except ValueError:
    PROXY_HOPS = 1

JOBS: dict[str, dict] = {}            # in-memory job state
JOBS_LOCK = threading.Lock()

# ── sessions (accounts + TOTP live in auth.py) ──────────────────────────────────────────────
SESSION_COOKIE = "vg_session"
PENDING_COOKIE = "vg_pending"          # password accepted, TOTP code still required
COOKIE_SECURE = os.environ.get("VIDEOGEN_COOKIE_SECURE") == "1"   # set once served over HTTPS

# ── engine registry: tier id → provider + per-engine constraints ─────────────
# Veo tier ids (lite/fast/quality) stay unchanged for backward compatibility.
ENGINES = {
    "lite":     {"provider": "veo",        "resolutions": {"720p", "1080p"}},
    "fast":     {"provider": "veo",        "resolutions": {"720p", "1080p"}},
    "quality":  {"provider": "veo",        "resolutions": {"720p", "1080p"}},
    "grok":     {"provider": "openrouter", "resolutions": {"480p", "720p"}},
    "seedance": {"provider": "openrouter", "resolutions": {"720p", "1080p"}},
    "seedance-fast": {"provider": "openrouter", "resolutions": {"720p", "1080p"}},
    "seedance-mini": {"provider": "openrouter", "resolutions": {"480p", "720p"}},
    "seedance-2.5": {"provider": "openrouter", "resolutions": {"480p", "720p"}},
    "ark-seedance-mini": {"provider": "ark", "resolutions": {"480p", "720p"}},
}
auth.ENGINE_IDS = list(ENGINES) + list(openrouter_chat.CHAT_MODELS) + list(openrouter_chat.IMAGE_MODELS)
# ^ admin page offers exactly these (video + chat + image) as per-user engine choices
DURATIONS = (4, 6, 8)                 # Veo's hard limit — Veo API rejects anything else
ASPECTS = ("16:9", "9:16")            # landscape / portrait (Shorts, Reels)


def valid_duration(tier: str, duration: int) -> bool:
    """Veo tiers are locked to 4/6/8s; OpenRouter/Ark engines use their own model range."""
    provider = ENGINES.get(tier, {}).get("provider")
    if provider == "openrouter":
        return duration in openrouter_video.MODELS.get(tier, {}).get("durations", DURATIONS)
    if provider == "ark":
        return duration in ark_video.MODELS.get(tier, {}).get("durations", DURATIONS)
    return duration in DURATIONS


def parse_user_durations(raw) -> tuple[int, ...]:
    """VIDEOGEN_USER_DURATIONS → clip lengths (seconds) ordinary users may pick. Unset → (5, 10). 'off'/'none'/'all'/'' → no limit."""
    default = (5, 10)
    if raw is None:
        return default
    text = str(raw).strip().lower()
    if text in ("", "off", "none", "all", "0"):
        return ()
    found = sorted({int(p) for p in text.replace(";", ",").split(",") if p.strip().isdigit() and 1 <= int(p) <= 60})
    return tuple(found) or default


USER_DURATIONS = parse_user_durations(os.environ.get("VIDEOGEN_USER_DURATIONS"))


def allowed_durations(user: dict) -> tuple[int, ...] | None:
    """The clip lengths this user may choose, or None for no limit (admins are never limited)."""
    return None if user["role"] == "admin" or not USER_DURATIONS else USER_DURATIONS


def snap_duration(value, allowed) -> int:
    """Nearest allowed length (ties go to the shorter, cheaper one)."""
    return min(allowed, key=lambda a: (abs(a - value), a))


def validate_engine(tier: str, resolution: str, aspect: str = "16:9") -> str | None:
    """Returns an error message, or None when tier+resolution+aspect are valid."""
    spec = ENGINES.get(tier)
    if spec is None:
        return "invalid tier"
    if resolution not in spec["resolutions"]:
        return f"{tier} supports {sorted(spec['resolutions'])} only"
    if aspect not in ASPECTS:
        return f"aspect must be one of {list(ASPECTS)}"
    if aspect == "9:16" and resolution == "1080p" and spec["provider"] == "veo":
        return "9:16 on Veo supports 720p only"
    return None


def check_engine_key(tier: str) -> None:
    """Raises RuntimeError when the engine's API key is missing."""
    provider = ENGINES[tier]["provider"]
    if provider == "openrouter":
        openrouter_video.load_api_key()
    elif provider == "ark":
        ark_video.load_api_key()
    else:
        veo.load_api_key()


def engine_estimate(tier: str, resolution: str, duration: int) -> float:
    provider = ENGINES[tier]["provider"]
    if provider == "openrouter":
        return openrouter_video.estimate_cost(tier, resolution, duration)
    if provider == "ark":
        return ark_video.estimate_cost(tier, resolution, duration)
    return veo.estimate_cost(tier, resolution, duration)


def engine_generate(tier: str, prompt: str, out_dir: Path, *, image_path: Path | None,
                    resolution: str, duration: int, aspect_ratio: str = "16:9",
                    reference_paths: list[Path] | None = None, progress) -> dict:
    """Dispatch one clip generation to the engine's provider module."""
    provider = ENGINES[tier]["provider"]
    if provider == "openrouter":
        return openrouter_video.generate_clip(
            prompt, out_dir, engine=tier, image_path=image_path,
            resolution=resolution, duration=duration, aspect_ratio=aspect_ratio,
            reference_paths=reference_paths, progress=progress)
    if provider == "ark":
        return ark_video.generate_clip(
            prompt, out_dir, engine=tier, image_path=image_path,
            resolution=resolution, duration=duration, aspect_ratio=aspect_ratio,
            reference_paths=reference_paths, progress=progress)
    return veo.generate_clip(
        prompt, out_dir, image_path=image_path,
        tier=tier, resolution=resolution, duration=duration,
        aspect_ratio=aspect_ratio, reference_paths=reference_paths, progress=progress)


def make_id(prompt: str) -> str:
    ts = datetime.now().strftime("%Y%m%d-%H%M%S")
    slug = SLUG_RE.sub("-", (prompt or "").lower())[:40].strip("-") or "untitled"
    return f"{ts}-{slug}-{uuid.uuid4().hex[:6]}"


def job_update(job_id: str, **fields) -> None:
    settle = usage = None
    with JOBS_LOCK:
        job = JOBS.setdefault(job_id, {})
        job.update(fields)
        if job.get("status") == "done" and job.get("kind") and not job.get("logged"):
            job["logged"] = True                      # one usage row per job, whatever happens to later updates
            cost = job.get("cost") or 0
            usage = (job.get("owner"), job["kind"], job.get("engine", ""), cost,
                     auth.to_micro(cost * PRICE_MULTIPLIER) if job.get("reserved") else 0)
        # finished job holding a credit reservation → settle exactly once (failed = full refund)
        if job.get("status") in ("done", "failed") and job.get("reserved") and not job.get("settled"):
            job["settled"] = True
            actual = auth.to_micro((job.get("cost") or 0) * PRICE_MULTIPLIER) if job["status"] == "done" else 0
            settle = (job["owner"], job["reserved"], actual)
    if settle:
        auth.settle(*settle)
    if usage and usage[0]:
        auth.record_usage(*usage)                     # provider cost vs what the user was charged → admin profit view


def run_generation(job_id: str, gen_id: str, payload: dict, image_path: Path | None,
                   ref_paths: list[Path] | None = None) -> None:
    out_dir = GENERATIONS / gen_id
    try:
        meta = engine_generate(
            payload["tier"], payload["prompt"], out_dir,
            image_path=image_path,
            resolution=payload["resolution"], duration=payload["duration"],
            aspect_ratio=payload.get("aspect", "16:9"),
            reference_paths=ref_paths,
            progress=lambda msg: job_update(job_id, status="running", detail=msg),
        )
        meta.update({
            "id": gen_id,
            "createdAt": datetime.now(timezone.utc).isoformat(),
            "prompt": payload["prompt"],
            "kind": "clip",
            "hasImage": image_path is not None,
        })
        (out_dir / "meta.json").write_text(json.dumps(meta, indent=2, ensure_ascii=False))
        job_update(job_id, status="done", detail="done", genId=gen_id, cost=meta["cost"])
    except Exception as exc:  # report sanitized message to the UI
        job_update(job_id, status="failed", detail=_redact(str(exc))[:500])
        shutil.rmtree(out_dir, ignore_errors=True)


def run_stitch(job_id: str, gen_id: str, clip_ids: list[str]) -> None:
    out_dir = GENERATIONS / gen_id
    try:
        paths = [GENERATIONS / cid / "clip.mp4" for cid in clip_ids]
        out_dir.mkdir(parents=True, exist_ok=True)
        job_update(job_id, status="running", detail="stitching")
        veo.stitch(paths, out_dir / "clip.mp4")
        veo.extract_frames(out_dir / "clip.mp4", out_dir / "frames")
        total = sum(_load_meta(cid).get("duration", 0) for cid in clip_ids)
        meta = {
            "id": gen_id,
            "createdAt": datetime.now(timezone.utc).isoformat(),
            "prompt": f"Stitched {len(clip_ids)} clips",
            "kind": "stitch",
            "sourceIds": clip_ids,
            "duration": total,
            "cost": 0,
            "clipPath": "clip.mp4",
        }
        (out_dir / "meta.json").write_text(json.dumps(meta, indent=2, ensure_ascii=False))
        job_update(job_id, status="done", detail="done", genId=gen_id, cost=0)
    except Exception as exc:
        job_update(job_id, status="failed", detail=_redact(str(exc))[:500])
        shutil.rmtree(out_dir, ignore_errors=True)


def _finalize_story(story_id: str, clip_ids: list[str], title: str, tier: str,
                    resolution: str, pending: list[dict], created_at: str | None = None,
                    aspect: str = "16:9") -> dict:
    """Stitch completed clips and write the story meta. status=partial when scenes remain."""
    out_dir = GENERATIONS / story_id
    out_dir.mkdir(parents=True, exist_ok=True)
    veo.stitch([GENERATIONS / c / "clip.mp4" for c in clip_ids], out_dir / "clip.mp4")
    veo.extract_frames(out_dir / "clip.mp4", out_dir / "frames")
    clip_metas = [_load_meta(c) for c in clip_ids]
    meta = {
        "id": story_id,
        "createdAt": created_at or datetime.now(timezone.utc).isoformat(),
        "prompt": title,
        "kind": "story",
        "status": "partial" if pending else "complete",
        "sourceIds": clip_ids,
        "pendingScenes": pending,
        "tier": tier,
        "resolution": resolution,
        "aspectRatio": aspect,
        "duration": sum(m.get("duration", 0) for m in clip_metas),
        "cost": round(sum(m.get("cost", 0) for m in clip_metas), 4),
        "clipPath": "clip.mp4",
    }
    (out_dir / "meta.json").write_text(json.dumps(meta, indent=2, ensure_ascii=False))
    return meta


def run_story(job_id: str, story_id: str, payload: dict, image_paths: list[Path],
              prior_ids: list[str] | None = None, created_at: str | None = None,
              ref_paths: list[Path] | None = None) -> None:
    """Generate scenes sequentially, stitch into one story video.

    On mid-run failure (e.g. 429 quota) with at least one clip done, the story is
    stitched from completed clips and saved as status=partial with the remaining
    scene definitions in pendingScenes — resumable via /api/story/resume.
    """
    out_dir = GENERATIONS / story_id
    scenes = payload["scenes"]
    prior_ids = list(prior_ids or [])
    n_total = len(prior_ids) + len(scenes)
    title = payload.get("title") or f"Story — {n_total} scenes"
    clip_ids = list(prior_ids)
    new_done = 0
    try:
        for k, scene in enumerate(scenes):
            i = len(prior_ids) + k
            cid = f"{story_id}-c{i + 1:02d}"
            prefix = f"clip {i + 1}/{n_total}: "
            idx = scene.get("imageIndex")
            img = image_paths[idx] if idx is not None else None
            meta = engine_generate(
                payload["tier"], scene["prompt"], GENERATIONS / cid,
                image_path=img,
                resolution=payload["resolution"], duration=scene["duration"],
                aspect_ratio=payload.get("aspect", "16:9"),
                reference_paths=ref_paths,
                progress=lambda msg, p=prefix: job_update(job_id, status="running", detail=p + msg),
            )
            meta.update({
                "id": cid,
                "createdAt": datetime.now(timezone.utc).isoformat(),
                "prompt": scene["prompt"],
                "kind": "clip",
                "storyId": story_id,
                "hasImage": img is not None,
            })
            (GENERATIONS / cid / "meta.json").write_text(json.dumps(meta, indent=2, ensure_ascii=False))
            clip_ids.append(cid)
            new_done += 1

        job_update(job_id, status="running", detail="stitching")
        meta = _finalize_story(story_id, clip_ids, title, payload["tier"], payload["resolution"],
                               pending=[], created_at=created_at,
                               aspect=payload.get("aspect", "16:9"))
        job_update(job_id, status="done", detail="done", genId=story_id, cost=new_run_cost(meta["cost"], prior_ids))
    except Exception as exc:
        err = _redact(str(exc))[:300]
        if clip_ids:  # save a playable partial story + what's left to generate
            pending = scenes[new_done:]
            try:
                job_update(job_id, status="running", detail="rate limited — stitching partial story")
                meta = _finalize_story(story_id, clip_ids, title, payload["tier"], payload["resolution"],
                                       pending=pending, created_at=created_at,
                                       aspect=payload.get("aspect", "16:9"))
                job_update(job_id, status="done", genId=story_id, cost=new_run_cost(meta["cost"], prior_ids), partial=True,
                           detail=f"partial: {len(clip_ids)}/{n_total} scenes done ({err}) — "
                                  f"use Generate remaining when quota resets")
                return
            except Exception as stitch_exc:
                err = f"{err}; stitch failed: {_redact(str(stitch_exc))[:150]}"
        job_update(job_id, status="failed", detail=f"failed at clip {len(clip_ids) + 1}/{n_total}: {err}")
        if not (out_dir / "clip.mp4").is_file():
            shutil.rmtree(out_dir, ignore_errors=True)


# ── Haiku prompt enhancer (Info-project ✨ pattern, server-side key) ──────────
ANTHROPIC_URL = "https://api.anthropic.com/v1/messages"   # hardcoded — never user-derived
ENHANCER_MODEL = "claude-haiku-4-5-20251001"
ENHANCER_SYSTEM = (
    "You are an animation director writing prompts for Veo 3.1 image-to-video generation. "
    "Given a scene script (action + dialogue) and optionally its starting-frame image, write ONE "
    "production-ready animation prompt. Rules: WITH an image, open with a style lock sentence such "
    "as '3D Pixar-style animation. Maintain the exact art style, characters, lighting and layout of "
    "the starting frame.' — adapt the style wording to what the image actually shows. WITHOUT an "
    "image (text-to-video), invent and fully specify the visual design yourself: art style, "
    "characters' appearance, setting, lighting and color palette — concrete enough that every shot "
    "could be re-generated consistently. Describe "
    "camera movement, character motion and ambient effects concretely. State character constraints "
    "positively (e.g. 'Exactly two children — no other children'). If the scene has dialogue, end "
    "with a 'Dialogue:' block, lines formatted Speaker (tone): \"line\" — max 4 short lines per "
    "8 seconds or speech gets rushed. Forbid text overlays: include 'no text, no logos, no "
    "watermarks'. Output ONLY the prompt text, no commentary."
)


WRITER_SYSTEM = (
    "You are a children's story writer for short animated videos (ages 4-8 unless told otherwise). "
    "Given a story idea, write a video script with exactly the requested number of scenes. "
    "STRICT FORMAT for every scene:\n\n"
    "Clip {n} — {Short Title}\n"
    "{1-3 sentences describing the visual action, present tense, concrete and animatable in 6-8 seconds}\n"
    "Dialogue:\n"
    "{Speaker}: \"{short line}\"\n\n"
    "Rules: 1-3 dialogue lines per scene (never more than 4); speaker names 15 characters or less; "
    "dialogue lines 12 words or less; warm, playful, gently educational when the topic suits; "
    "a satisfying ending in the final scene; blank line between scenes; "
    "output ONLY the script — no commentary, no markdown headers."
)


RESTRUCTURE_SYSTEM = (
    "You are a video script editor. The user gives you a video prompt or scene description "
    "that is NOT yet split into clips. Split it into 2-6 clips (or the requested number), "
    "each animatable in 4-8 seconds. STRICT FORMAT for every clip:\n\n"
    "Clip {n} — {Short Title}\n"
    "{1-3 sentences of visual action from the user's text, present tense}\n"
    "Dialogue:\n"
    "{Speaker}: \"{line}\"\n\n"
    "Rules: PRESERVE the user's content — characters, style descriptions, lighting, camera moves "
    "and dialogue. Distribute the existing dialogue across clips in original order; never invent "
    "new plot or new lines. Speaker names plain (no parenthetical tones), 15 characters or less; "
    "max 4 dialogue lines per clip; blank line between clips; "
    "output ONLY the script — no commentary, no markdown headers."
)


STORYBOARD_SYSTEM = (
    "You are a storyboard reader for AI video generation. The user gives you ONE image that "
    "contains a multi-panel storyboard / shot list (panels arranged top-to-bottom or in a grid). "
    "Read every panel in order and turn each into one animation scene. "
    "Return ONLY valid JSON — no markdown, no commentary — in exactly this shape:\n"
    '{"title": "<short movie title>", "style": "<global look + cast + voice bible>", '
    '"char_box": [x0, y0, x1, y1], "scenes": [{"prompt": "<scene action prompt>"}, ...]}\n'
    '"char_box" = the fractional coordinates (0..1, x0<x1, y0<y1) of a TIGHT crop around just the '
    "main characters' faces and upper bodies in their clearest, most front-facing group close-up. "
    "Make it as SMALL as possible while still including every main character — exclude scenery, "
    "wide backgrounds, title cards and ANY printed text/captions. Prefer a mid-story panel over the "
    "title/ending panel. This crop becomes the character reference so they look identical in every clip.\n"
    'The "style" string (2-4 sentences) is the consistency lock that will be applied to EVERY clip: '
    "name the art style (e.g. '3D Pixar-style animation, warm cinematic lighting'), describe each "
    "recurring character's FIXED look (hair, clothing, colors, age), and name ONE narrator voice to use "
    'throughout (e.g. \'a warm female narrator\'). '
    'Each scene "prompt" (2-4 sentences): the present-tense visual ACTION of that panel only — what '
    "moves, the camera, the mood — animatable in 6-8 seconds, plus any spoken line as "
    'Dialogue: {Speaker}: "{short line}".  '
    "Describe only what HAPPENS in the scene. NEVER mention panels, grids, frame numbers, captions, "
    "labels, diagrams or any text printed on the storyboard — those must not appear in the video. "
    "One JSON scene per panel, in top-to-bottom order. Output JSON only."
)


def _haiku(api_key: str, system: str, content: list) -> str:
    """One Claude Haiku call. content = Anthropic messages content blocks."""
    body = json.dumps({
        "model": ENHANCER_MODEL,
        "max_tokens": 2048,
        "system": system,
        "messages": [{"role": "user", "content": content}],
    }).encode("utf-8")
    req = urllib_request.Request(ANTHROPIC_URL, data=body, headers={
        "Content-Type": "application/json",
        "x-api-key": api_key,
        "anthropic-version": "2023-06-01",
    })
    try:
        with urllib_request.urlopen(req, timeout=90) as r:
            data = json.loads(r.read().decode("utf-8"))
    except HTTPError as e:
        detail = _redact(e.read().decode("utf-8", "replace"))[:300]
        raise RuntimeError(f"Anthropic API {e.code}: {detail}")
    parts = [b.get("text", "") for b in data.get("content", []) if b.get("type") == "text"]
    text = "\n".join(parts).strip()
    if not text:
        raise RuntimeError("empty response")
    return text


def load_anthropic_key() -> str:
    key = os.environ.get("ANTHROPIC_API_KEY", "").strip() or veo.config_key("anthropic")
    if not key:
        key = veo.home_key_file(".anthropic_api_key")
    if not key:
        raise RuntimeError(
            "No Anthropic key. Add it to config.json, set ANTHROPIC_API_KEY, or create "
            "~/.anthropic_api_key (chmod 600) to use ✨ Enhance."
        )
    return key


def _classify_with_haiku(wrapped: str) -> str:
    """Safety classifier call (see safety.CLASSIFIER_SYSTEM) — raises if the key/API is unavailable → fail-closed."""
    return _haiku(load_anthropic_key(), safety.CLASSIFIER_SYSTEM, [{"type": "text", "text": wrapped}])


safety.configure(_classify_with_haiku)


def _classify_image_with_haiku(jpeg: bytes, mime: str) -> str:
    """Vision safety check of an uploaded picture (see safety.IMAGE_CLASSIFIER_SYSTEM) — raises → fail-closed."""
    b64 = base64.b64encode(jpeg).decode()
    return _haiku(load_anthropic_key(), safety.IMAGE_CLASSIFIER_SYSTEM, [
        {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": b64}},
        {"type": "text", "text": "Classify this image."}])


safety.configure_image(_classify_image_with_haiku)
MSG_TIME_UP = "Time's up for today! You can still look at your Library. See you tomorrow!"
UPLOAD_MAX_BYTES = 2 * 1024 * 1024      # a picture attached in Chat / Pictures must be SMALLER than this (decoded)


def enhance_scene(api_key: str, scene_text: str, image_b64: str | None, image_mime: str | None) -> str:
    content = []
    if image_b64 and image_mime in IMAGE_MIMES:
        if "," in image_b64:
            image_b64 = image_b64.split(",", 1)[1]
        content.append({"type": "image", "source": {
            "type": "base64", "media_type": image_mime, "data": image_b64}})
    content.append({"type": "text", "text": f"Scene script:\n\n{scene_text}"})
    return _haiku(api_key, ENHANCER_SYSTEM, content)


def _redact(text: str) -> str:
    """Strip anything that looks like an API key or key query param."""
    text = re.sub(r"key=[^&\s\"']+", "key=REDACTED", text)
    text = re.sub(r"\bsk-or-[A-Za-z0-9_\-]+\b", "REDACTED", text)
    return re.sub(r"\b(AIza[0-9A-Za-z_\-]{10,}|AQ\.[0-9A-Za-z_\-]{10,})\b", "REDACTED", text)


def _save_b64_images(raw_list: list, out_dir: Path, prefix: str, max_n: int):
    """Validate + save a list of {base64, mime} images. Returns (paths, error)."""
    if not isinstance(raw_list, list) or len(raw_list) > max_n:
        return None, f"max {max_n} {prefix} images"
    paths: list[Path] = []
    for i, img in enumerate(raw_list):
        mime = str((img or {}).get("mime", "")).lower()
        b64 = (img or {}).get("base64") or ""
        if mime not in IMAGE_MIMES:
            return None, f"{prefix} image {i + 1}: type must be one of {sorted(IMAGE_MIMES)}"
        if "," in b64:
            b64 = b64.split(",", 1)[1]
        try:
            raw = base64.b64decode(b64, validate=True)
        except Exception:
            return None, f"{prefix} image {i + 1}: invalid base64"
        if len(raw) > 20 * 1024 * 1024:
            return None, f"{prefix} image {i + 1}: exceeds 20 MB"
        out_dir.mkdir(parents=True, exist_ok=True)
        path = out_dir / f"{prefix}{i + 1:02d}.{IMAGE_MIMES[mime]}"
        path.write_bytes(raw)
        paths.append(path)
    return paths, None


# ── public parents page: GET /parents (no sign-in). Numbers in the text come from the live settings, so it can't drift ──
PUBLIC_UI_FILES = {                                   # exact paths only — everything else under /ui/ needs sign-in
    "/ui/login-hero-v2.jpg": ("login-hero-v2.jpg", "image/jpeg"),
    "/ui/parents-lab.jpg": ("parents-lab.jpg", "image/jpeg"),
    "/ui/parents-blocked.jpg": ("parents-blocked.jpg", "image/jpeg"),
    "/ui/parents-example.jpg": ("parents-example.jpg", "image/jpeg"),
    "/ui/parents-hero.webp": ("parents-hero.webp", "image/webp"),
    **{f"/ui/parents-ic-{n}.png": (f"parents-ic-{n}.png", "image/png")
       for n in ("sprout", "chat", "palette", "bulb", "shield", "sliders", "lock", "pencil")},
}      # exact paths only — everything else under /ui/ needs sign-in


def _join_or(nums) -> str:
    items = [str(n) for n in nums]
    return items[0] if len(items) == 1 else ", ".join(items[:-1]) + " or " + items[-1]


def parents_context() -> dict:
    """Replacement text for the {{...}} markers in ui/parents.html (all values are built here — no user input)."""
    hours = VIDEO_RETENTION_HOURS
    if hours:
        h = int(hours) if float(hours).is_integer() else hours
        retention = (f"Deleted automatically {h} hours after they are made, together with the words used for each scene. "
                     "The child can also delete a video sooner.")
    else:
        retention = "Kept until deleted, with the words used for each scene. The child can delete a video from My Library."
    if USER_DURATIONS:
        clip_text = f"Children can make clips of {_join_or(USER_DURATIONS)} seconds."
        clip_control = f"Children can only make clips of {_join_or(USER_DURATIONS)} seconds. Adults are not limited."
    else:
        clip_text = "Clip length depends on the engine chosen."
        clip_control = "No clip-length limit is set for children at the moment."
    logo = f'<img src="{auth._LOGO}" alt="">' if auth._LOGO else ""
    return {"{{LOGO}}": logo, "{{STRIKES}}": str(auth.STRIKE_LIMIT), "{{RETENTION_TEXT}}": retention,
            "{{CLIP_TEXT}}": clip_text, "{{CLIP_CONTROL}}": clip_control}


def render_parents() -> str:
    page = (ROOT / "ui" / "parents.html").read_text(encoding="utf-8")
    for marker, text in parents_context().items():
        page = page.replace(marker, text)
    return page


# ── curated examples: read-only samples (video + prompt + pictures) shown to every signed-in user ──────────────────────────
# Bundled in the repo (tools/bundle_example.py), so they are reviewed before shipping and are untouched by video retention.
EXAMPLES_DIR = ROOT / "examples"
EXAMPLE_SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]{1,60}$")
EXAMPLE_FILE_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}\.(mp4|jpg|jpeg|png|webp)$")       # json and anything else is never served
EXAMPLE_ROLES = {"character", "scene", "start", "storyboard"}


def _clean_example(folder: Path, raw) -> dict | None:
    """Validate one example.json and turn it into the public shape (URLs, no internal fields); None = unusable."""
    if not isinstance(raw, dict):
        return None

    def text(v, limit):
        return v.strip()[:limit] if isinstance(v, str) else ""

    def exists(name, exts):
        return (isinstance(name, str) and EXAMPLE_FILE_RE.match(name) and name.rsplit(".", 1)[1].lower() in exts
                and (folder / name).is_file() and not (folder / name).is_symlink())

    title = text(raw.get("title"), 120)
    video = raw.get("video")
    if not title or not exists(video, {"mp4"}):
        return None
    scenes = []
    for i, s in enumerate((raw.get("scenes") if isinstance(raw.get("scenes"), list) else [])[:30], 1):
        prompt = text((s or {}).get("prompt") if isinstance(s, dict) else "", 8000)
        if not prompt:
            return None
        dur = s.get("duration")
        scenes.append({"n": i, "duration": dur if isinstance(dur, int) and 0 <= dur <= 60 else 0, "prompt": prompt})
    if not scenes:
        return None
    summary = text(raw.get("summary"), 400)
    if any(safety.local_check(t) for t in [title, summary] + [s["prompt"] for s in scenes]):
        print(f"examples: skipping {folder.name} — the safety word list flagged its text")
        return None
    base = f"/examples/{folder.name}/"
    assets = []
    for a in (raw.get("assets") if isinstance(raw.get("assets"), list) else [])[:12]:
        if isinstance(a, dict) and exists(a.get("file"), {"jpg", "jpeg", "png", "webp"}) and a.get("role") in EXAMPLE_ROLES:
            assets.append({"url": base + a["file"], "role": a["role"], "label": text(a.get("label"), 100)})
    poster = raw.get("poster")
    order = raw.get("order")
    dur = raw.get("duration")
    return {"id": folder.name, "title": title, "summary": summary, "kind": text(raw.get("kind"), 12),
            "engine": text(raw.get("engine"), 60), "resolution": text(raw.get("resolution"), 12),
            "aspect": raw.get("aspect") if raw.get("aspect") in ("16:9", "9:16", "1:1") else "16:9",
            "duration": dur if isinstance(dur, int) and 0 <= dur <= 600 else sum(s["duration"] for s in scenes),
            "sceneCount": len(scenes), "scenes": scenes, "assets": assets, "videoUrl": base + video,
            "posterUrl": base + poster if exists(poster, {"jpg", "jpeg", "png", "webp"}) else None,
            "order": order if isinstance(order, int) else 100}


def load_examples(root: Path | None = None) -> list[dict]:
    """All valid examples under examples/ (a broken or tampered one is skipped, never served)."""
    root = root or EXAMPLES_DIR
    out = []
    if not root.is_dir():
        return out
    for folder in sorted(root.iterdir()):
        if folder.is_symlink() or not folder.is_dir() or not EXAMPLE_SLUG_RE.match(folder.name):
            continue
        try:
            raw = json.loads((folder / "example.json").read_text())
        except (OSError, ValueError):
            continue
        ex = _clean_example(folder, raw)
        if ex:
            out.append(ex)
    return sorted(out, key=lambda e: (e["order"], e["title"].lower()))


# ── retention: video assets expire, pictures and scripts stay ─────────────────────────────────────────────────
VIDEO_KINDS = {"clip", "story", "stitch"}             # everything that is a video; 'image' and 'script' are never expired


def parse_retention_hours(raw) -> float:
    """VIDEOGEN_VIDEO_RETENTION_HOURS → hours to keep videos. 0 / empty / junk = keep forever (safe default for local use)."""
    try:
        v = float(raw or 0)
    except (TypeError, ValueError):
        return 0.0
    return min(v, 24.0 * 365) if v == v and v > 0 else 0.0


VIDEO_RETENTION_HOURS = parse_retention_hours(os.environ.get("VIDEOGEN_VIDEO_RETENTION_HOURS"))
ACTIVE_GENS: set[str] = set()                         # generations being produced right now — never purged


def _tracked(gen_id: str, fn):
    """Thread target that marks gen_id (and, for stories, its clip folders) as in use while it runs."""
    def run(*args, **kwargs):
        ACTIVE_GENS.add(gen_id)
        try:
            return fn(*args, **kwargs)
        finally:
            ACTIVE_GENS.discard(gen_id)
    return run


def video_expires_at(meta: dict, hours: float | None = None) -> str | None:
    """ISO time a video expires, or None (not a video / retention off / no usable creation time)."""
    hours = VIDEO_RETENTION_HOURS if hours is None else hours
    if hours <= 0 or meta.get("kind") not in VIDEO_KINDS:
        return None
    try:
        created = datetime.fromisoformat(str(meta["createdAt"]))
    except (KeyError, ValueError):
        return None
    if created.tzinfo is None:
        created = created.replace(tzinfo=timezone.utc)
    return (created + timedelta(hours=hours)).isoformat()


def purge_expired_videos(now: datetime | None = None, hours: float | None = None, dry_run: bool = False) -> list[str]:
    """Delete video folders older than the retention window; returns the ids removed (or that would be, on a dry run).

    Safe by construction: only direct children of generations/ with a valid id, a readable meta.json whose kind is a video
    and a parseable creation time; never symlinks; never anything in ACTIVE_GENS (or a clip folder of an active story)."""
    hours = VIDEO_RETENTION_HOURS if hours is None else hours
    if hours <= 0 or not GENERATIONS.is_dir():
        return []
    now = now or datetime.now(timezone.utc)
    removed: list[str] = []
    for child in sorted(GENERATIONS.iterdir()):
        name = child.name
        if child.is_symlink() or not child.is_dir() or not ID_RE.match(name):
            continue
        if any(name == a or name.startswith(a + "-c") for a in list(ACTIVE_GENS)):
            continue
        expires = video_expires_at(_load_meta(name), hours)
        if not expires or datetime.fromisoformat(expires) >= now:
            continue                                          # not a video, no date, or still within its window
        if not dry_run:
            try:
                shutil.rmtree(child)
            except OSError as exc:
                print(f"retention: could not remove {name}: {exc}")
                continue
            auth.release(name)
        removed.append(name)
    return removed


def start_retention_thread(interval: int = 1800):
    """Background cleanup every `interval` seconds (first run a minute after start). None when retention is off."""
    if VIDEO_RETENTION_HOURS <= 0:
        return None

    def loop():
        time.sleep(60)
        while True:
            try:
                gone = purge_expired_videos()
                if gone:
                    print(f"retention: removed {len(gone)} video(s) older than {VIDEO_RETENTION_HOURS:g} h")
            except Exception as exc:                          # the cleaner must never take the server down
                print(f"retention: error {type(exc).__name__}: {exc}")
            time.sleep(interval)

    t = threading.Thread(target=loop, daemon=True, name="video-retention")
    t.start()
    return t


def new_run_cost(total_cost: float, prior_ids: list[str]) -> float:
    """Provider cost of THIS run only. A resumed story's meta cost is cumulative (it sums every clip, old and new), but the
    earlier clips were already billed by the run that made them — charging the total again would bill them twice."""
    prior = sum(_load_meta(c).get("cost", 0) for c in prior_ids)
    return round(max(0.0, total_cost - prior), 4)


def _load_meta(gen_id: str) -> dict:
    try:
        return json.loads((GENERATIONS / gen_id / "meta.json").read_text())
    except Exception:
        return {}


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    # ── routing ──────────────────────────────────────────────────────────────
    def do_HEAD(self):
        # SimpleHTTPRequestHandler would answer HEAD for ANY file under the project folder before any login or host check
        # (leaking which files exist and how big they are). We never need HEAD.
        self.send_error(405, "method not allowed")

    def do_GET(self):
        if self.path.split("?", 1)[0] == "/healthz":      # platform health check: no data, no auth, no host check
            body = b"ok"
            self.send_response(200)
            self.send_header("Content-Type", "text/plain")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
            return
        if not self._host_ok():
            return
        path = self.path.split("?", 1)[0]
        if path in PUBLIC_UI_FILES:                         # the few assets the sign-in and parents pages need before anyone is signed in
            return self._public_file(PUBLIC_UI_FILES[path])
        if path in ("/parents", "/parents/") or (path == "/" and not self._authed()):
            return self._html(200, render_parents())        # public landing page: shared links and first visits land here, signed-in users get the app
        if path == "/login":
            return self._html(200, auth.login_page())
        if path == "/login/2fa":
            return self._html(200, auth.totp_page())
        if path.startswith("/enroll/"):
            token = path[len("/enroll/"):]
            user = auth.enrollment_user(token)
            if not user:
                return self._html(404, auth.login_page("This setup link was already used, replaced by a newer one, or has expired. If you already finished setting up, just sign in; otherwise ask your admin for a new link."))
            return self._html(200, auth.enroll_page(token, user))
        if not self._authed():
            return self._redirect("/login")
        if path == "/admin":
            return self._admin_get()
        if path == "/":
            return self._index()                  # kid-friendly tabbed UI (design handoff)
        if path == "/classic":
            self.path = "/video-generator.html"   # original dark single-page UI
            return super().do_GET()
        if path == "/api/me":
            return self._me()
        if path == "/api/models":
            return self._models()
        if path == "/api/examples":
            return self._json(200, load_examples())
        if path.startswith("/examples/"):
            return self._example_file(path)
        if path == "/api/list":
            return self._list()
        if path.startswith("/api/job/"):
            return self._job(path[len("/api/job/"):])
        if path.startswith("/generations/"):
            return self._static_generation()
        # default-deny static files: the project root holds code, users.db and config.json — only
        # the UI assets are served (normalised first so ../ and %2e%2e tricks can't escape the list)
        norm = posixpath.normpath(unquote(path))
        if norm.startswith("/ui/") or norm == "/video-generator.html":
            return super().do_GET()
        return self.send_error(404)

    def do_POST(self):
        if not self._host_ok():
            return
        path = self.path.split("?", 1)[0]
        if path == "/login":
            return self._login_post()
        if path == "/login/2fa":
            return self._totp_post()
        if path.startswith("/enroll/"):
            return self._enroll_post(path[len("/enroll/"):])
        if path == "/logout":
            return self._logout()
        if not self._authed():
            return self._json(401, {"error": "unauthorized"})
        if path.startswith("/admin/"):
            return self._admin_post()
        if path == "/api/ping":
            return self._ping()
        if path.startswith("/api/"):
            # every create/spend action counts as activity, and is refused once today's allowance is used up
            # (the Library — GETs and delete — stays open). Enforced here so hiding buttons in the page isn't the control.
            clock = auth.touch(self.user["id"])
            if self.user["role"] == "user" and clock and clock["up"]:
                return self._json(423, {"error": MSG_TIME_UP, "timeUp": True})
        if self.path == "/api/generate":
            return self._generate()
        if self.path == "/api/story":
            return self._story()
        if self.path == "/api/enhance":
            return self._enhance()
        if self.path == "/api/story/resume":
            return self._story_resume()
        if self.path == "/api/write-story":
            return self._write_story()
        if self.path == "/api/restructure":
            return self._restructure()
        if self.path == "/api/storyboard":
            return self._storyboard()
        if self.path == "/api/stitch":
            return self._stitch()
        if self.path == "/api/chat":
            return self._chat()
        if self.path == "/api/image":
            return self._image()
        if self.path == "/api/story-review":
            return self._story_review()
        self.send_error(404)

    def do_DELETE(self):
        if not self._host_ok():
            return
        if not self._authed():
            return self._json(401, {"error": "unauthorized"})
        if self.path.startswith("/api/delete/"):
            return self._delete(self.path[len("/api/delete/"):])
        self.send_error(404)

    # ── endpoints ────────────────────────────────────────────────────────────
    def _generate(self):
        payload = self._json_body()
        if payload is None:
            return self._json(413, {"error": "request too large"})

        prompt = str(payload.get("prompt", "")).strip()
        tier = str(payload.get("tier", "lite"))
        resolution = str(payload.get("resolution", "720p"))
        aspect = str(payload.get("aspect", "16:9"))
        try:
            duration = int(payload.get("duration", 8))
        except (TypeError, ValueError):
            duration = 0
        if not prompt or len(prompt) > 8000:
            return self._json(400, {"error": "prompt required (max 8000 chars)"})
        engine_err = validate_engine(tier, resolution, aspect) or self._duration_error(tier, duration)
        if engine_err:
            return self._json(400, {"error": engine_err})
        if self._engine_denied(tier) or not self._guard(prompt, "generate"):
            return

        gen_id = self._new_id(prompt)
        image_path = None
        img_b64 = payload.get("imageBase64") or ""
        if img_b64:
            mime = str(payload.get("imageMime", "")).lower()
            if mime not in IMAGE_MIMES:
                return self._json(400, {"error": f"image type must be one of {sorted(IMAGE_MIMES)}"})
            if "," in img_b64:
                img_b64 = img_b64.split(",", 1)[1]
            try:
                raw = base64.b64decode(img_b64, validate=True)
            except Exception:
                return self._json(400, {"error": "invalid base64 image"})
            if len(raw) > 20 * 1024 * 1024:
                return self._json(400, {"error": "image exceeds 20 MB"})
            out_dir = GENERATIONS / gen_id
            out_dir.mkdir(parents=True, exist_ok=True)
            image_path = out_dir / f"start.{IMAGE_MIMES[mime]}"
            image_path.write_bytes(raw)

        # character reference images (consistent characters, never shown on screen)
        ref_paths, ref_err = _save_b64_images(payload.get("referenceImages") or [],
                                              GENERATIONS / gen_id, "ref", MAX_REF_IMAGES)
        if ref_err:
            shutil.rmtree(GENERATIONS / gen_id, ignore_errors=True)
            return self._json(400, {"error": ref_err})

        try:
            check_engine_key(tier)
        except RuntimeError as exc:
            shutil.rmtree(GENERATIONS / gen_id, ignore_errors=True)
            return self._json(503, {"error": str(exc)})

        job_id = uuid.uuid4().hex
        est = engine_estimate(tier, resolution, duration)
        if not self._charge(job_id, est, lambda: (shutil.rmtree(GENERATIONS / gen_id, ignore_errors=True),
                                                  auth.release(gen_id)), "video", tier):
            return
        job_update(job_id, status="queued", detail="queued", genId=None, owner=self.user["id"], estCost=est)
        args = {"prompt": prompt, "tier": tier, "resolution": resolution,
                "duration": duration, "aspect": aspect}
        threading.Thread(target=_tracked(gen_id, run_generation), args=(job_id, gen_id, args, image_path, ref_paths),
                         daemon=True).start()
        self._json(202, {"jobId": job_id, "genId": gen_id})

    def _story(self):
        payload = self._json_body()
        if payload is None:
            return self._json(413, {"error": "request too large"})

        tier = str(payload.get("tier", "lite"))
        resolution = str(payload.get("resolution", "720p"))
        aspect = str(payload.get("aspect", "16:9"))
        engine_err = validate_engine(tier, resolution, aspect)
        if engine_err:
            return self._json(400, {"error": engine_err})
        if self._engine_denied(tier) or self._out_of_credits():
            return

        raw_scenes = payload.get("scenes") or []
        raw_images = payload.get("images") or []
        if not isinstance(raw_scenes, list) or not (1 <= len(raw_scenes) <= MAX_SCENES):
            return self._json(400, {"error": f"need 1-{MAX_SCENES} scenes"})
        if not isinstance(raw_images, list) or len(raw_images) > MAX_STORY_IMAGES:
            return self._json(400, {"error": f"max {MAX_STORY_IMAGES} images"})

        scenes = []
        for i, s in enumerate(raw_scenes):
            prompt = str((s or {}).get("prompt", "")).strip()
            if not prompt or len(prompt) > 8000:
                return self._json(400, {"error": f"scene {i + 1}: prompt required (max 8000 chars)"})
            try:
                duration = int(s.get("duration", 8))
            except (TypeError, ValueError):
                duration = 0
            dur_err = self._duration_error(tier, duration)
            if dur_err:
                return self._json(400, {"error": f"scene {i + 1}: {dur_err}"})
            idx = s.get("imageIndex", None)
            if idx is not None:
                if not isinstance(idx, int) or not (0 <= idx < len(raw_images)):
                    return self._json(400, {"error": f"scene {i + 1}: imageIndex out of range"})
            scenes.append({"prompt": prompt, "duration": duration, "imageIndex": idx})
        if not self._guard("\n---\n".join([str(payload.get("title") or "")] + [sc["prompt"] for sc in scenes]), "story"):
            return

        story_id = self._new_id(payload.get("title") or "story")
        out_dir = GENERATIONS / story_id
        out_dir.mkdir(parents=True, exist_ok=True)

        image_paths: list[Path] = []
        for i, img in enumerate(raw_images):
            mime = str((img or {}).get("mime", "")).lower()
            b64 = (img or {}).get("base64") or ""
            if mime not in IMAGE_MIMES:
                shutil.rmtree(out_dir, ignore_errors=True)
                return self._json(400, {"error": f"image {i + 1}: type must be one of {sorted(IMAGE_MIMES)}"})
            if "," in b64:
                b64 = b64.split(",", 1)[1]
            try:
                raw = base64.b64decode(b64, validate=True)
            except Exception:
                shutil.rmtree(out_dir, ignore_errors=True)
                return self._json(400, {"error": f"image {i + 1}: invalid base64"})
            if len(raw) > 20 * 1024 * 1024:
                shutil.rmtree(out_dir, ignore_errors=True)
                return self._json(400, {"error": f"image {i + 1}: exceeds 20 MB"})
            path = out_dir / f"src{i + 1:02d}.{IMAGE_MIMES[mime]}"
            path.write_bytes(raw)
            image_paths.append(path)

        # character reference images — applied to every scene without its own start frame
        ref_paths, ref_err = _save_b64_images(payload.get("referenceImages") or [],
                                              out_dir, "ref", MAX_REF_IMAGES)
        if ref_err:
            shutil.rmtree(out_dir, ignore_errors=True)
            return self._json(400, {"error": ref_err})

        try:
            check_engine_key(tier)
        except RuntimeError as exc:
            shutil.rmtree(out_dir, ignore_errors=True)
            return self._json(503, {"error": str(exc)})

        job_id = uuid.uuid4().hex
        est = sum(engine_estimate(tier, resolution, s["duration"]) for s in scenes)
        if not self._charge(job_id, est, lambda: (shutil.rmtree(out_dir, ignore_errors=True),
                                                  auth.release(story_id)), "video", tier):
            return
        job_update(job_id, status="queued", detail="queued", genId=None, owner=self.user["id"], estCost=round(est, 4))
        args = {"scenes": scenes, "tier": tier, "resolution": resolution, "aspect": aspect,
                "title": str(payload.get("title") or "")[:200]}
        threading.Thread(target=_tracked(story_id, run_story), args=(job_id, story_id, args, image_paths),
                         kwargs={"ref_paths": ref_paths}, daemon=True).start()
        self._json(202, {"jobId": job_id, "genId": story_id, "estCost": round(est * PRICE_MULTIPLIER, 4)})

    def _write_story(self):
        """Claude Haiku writes a full multi-scene script from a one-line idea."""
        payload = self._json_body()
        if payload is None:
            return self._json(413, {"error": "request too large"})
        idea = str(payload.get("idea", "")).strip()
        if not idea or len(idea) > 2000:
            return self._json(400, {"error": "idea required (max 2000 chars)"})
        try:
            scene_count = int(payload.get("scenes", 3))
        except (TypeError, ValueError):
            scene_count = 0
        if not (1 <= scene_count <= 15):
            return self._json(400, {"error": "scenes must be 1-15"})
        audience = str(payload.get("audience", "")).strip()[:200]
        if not self._guard(f"{idea}\n{audience}", "write-story"):
            return
        try:
            api_key = load_anthropic_key()
        except RuntimeError as exc:
            return self._json(503, {"error": str(exc)})
        ask = f"Story idea: {idea}\n\nNumber of scenes: {scene_count}"
        if audience:
            ask += f"\nAudience: {audience}"
        try:
            script = _haiku(api_key, WRITER_SYSTEM, [{"type": "text", "text": ask}])
        except Exception as exc:
            return self._json(502, {"error": _redact(str(exc))[:300]})

        if not self._guard_output(script, "write-story"):
            return
        # archive the paid output — scripts are history too
        gid = self._new_id("script-" + idea)
        out_dir = GENERATIONS / gid
        out_dir.mkdir(parents=True, exist_ok=True)
        (out_dir / "script.txt").write_text(script)
        meta = {
            "id": gid,
            "createdAt": datetime.now(timezone.utc).isoformat(),
            "kind": "script",
            "prompt": f"📖 {idea}",
            "script": script,
            "sceneCount": scene_count,
            "cost": 0.01,
            "costNote": "Haiku story writing",
            "duration": 0,
        }
        (out_dir / "meta.json").write_text(json.dumps(meta, indent=2, ensure_ascii=False))
        self._json(200, {"script": script, "id": gid})

    def _restructure(self):
        """Split a headerless prompt/script into Clip-N format via Claude Haiku (content preserved)."""
        payload = self._json_body()
        if payload is None:
            return self._json(413, {"error": "request too large"})
        text = str(payload.get("script", "")).strip()
        if not text or len(text) > 16000:
            return self._json(400, {"error": "script required (max 16000 chars)"})
        if not self._guard(text, "restructure"):
            return
        try:
            api_key = load_anthropic_key()
        except RuntimeError as exc:
            return self._json(503, {"error": str(exc)})
        ask = f"Split this into clips:\n\n{text}"
        try:
            scene_count = int(payload.get("scenes", 0))
        except (TypeError, ValueError):
            scene_count = 0
        if 1 <= scene_count <= 15:
            ask = f"Split this into exactly {scene_count} clips:\n\n{text}"
        try:
            script = _haiku(api_key, RESTRUCTURE_SYSTEM, [{"type": "text", "text": ask}])
        except Exception as exc:
            return self._json(502, {"error": _redact(str(exc))[:300]})
        if not self._guard_output(script, "restructure"):
            return
        self._json(200, {"script": script})

    def _storyboard(self):
        """Image → movie: Haiku vision reads a storyboard image into scenes, then auto-generates.

        The storyboard is read (vision) but NOT used as a reference frame — every clip is
        text-to-video, with a shared style/cast/voice bible prepended to each prompt for
        consistency. Feeding the image to the engine bleeds it onto each clip's first frame.

        Security: image is MIME/size/base64 validated (same as _story); the Haiku JSON output is
        treated as hostile — length-capped, try/except parsed, shape-validated, and only the
        `style`/`prompt` strings are read (no dict spread, no user keys reach the path or engine).
        """
        payload = self._json_body()
        if payload is None:
            return self._json(413, {"error": "request too large"})

        tier = str(payload.get("tier", "lite"))
        resolution = str(payload.get("resolution", "720p"))
        aspect = str(payload.get("aspect", "16:9"))
        engine_err = validate_engine(tier, resolution, aspect)
        if engine_err:
            return self._json(400, {"error": engine_err})
        if self._engine_denied(tier) or self._out_of_credits():
            return

        # optional hard cap on how many panels we turn into clips (cost guard)
        try:
            max_scenes = int(payload.get("scenes", MAX_SCENES))
        except (TypeError, ValueError):
            max_scenes = MAX_SCENES
        max_scenes = max(1, min(max_scenes, MAX_SCENES))
        try:
            duration = int(payload.get("duration", 8))
        except (TypeError, ValueError):
            duration = 8
        limit = allowed_durations(self.user)
        if limit:                                    # ordinary users: the AI-split scenes all get an allowed length
            duration = snap_duration(duration, limit)
            dur_err = self._duration_error(tier, duration)
            if dur_err:
                return self._json(400, {"error": dur_err})
        elif not valid_duration(tier, duration):
            duration = 8

        # ── validate the storyboard image (identical posture to _story src images) ──
        mime = str(payload.get("imageMime", "")).lower()
        b64 = payload.get("imageBase64") or ""
        if mime not in IMAGE_MIMES:
            return self._json(400, {"error": f"image type must be one of {sorted(IMAGE_MIMES)}"})
        if "," in b64:
            b64 = b64.split(",", 1)[1]
        try:
            raw = base64.b64decode(b64, validate=True)
        except Exception:
            return self._json(400, {"error": "invalid base64 image"})
        if not raw or len(raw) > 20 * 1024 * 1024:
            return self._json(400, {"error": "image required (max 20 MB)"})

        try:
            api_key = load_anthropic_key()
        except RuntimeError as exc:
            return self._json(503, {"error": str(exc)})

        # ── Haiku vision: storyboard image → JSON scenes ──
        content = [{"type": "image", "source": {
            "type": "base64", "media_type": mime, "data": b64}},
            {"type": "text", "text": "Read this storyboard image and return the scenes JSON."}]
        try:
            reply = _haiku(api_key, STORYBOARD_SYSTEM, content)
        except Exception as exc:
            return self._json(502, {"error": _redact(str(exc))[:300]})

        # ── parse the LLM output defensively (hostile until proven otherwise) ──
        scenes, title, char_box = self._parse_storyboard_reply(reply, max_scenes, duration)
        if not scenes:
            return self._json(422, {"error": "could not read any scenes from the image"})
        if not self._guard("\n---\n".join([title or ""] + [sc["prompt"] for sc in scenes]), "storyboard"):
            return

        # ── persist the storyboard for the record, and crop ONE clean all-characters shot to use as
        # the visual character reference for every clip (input_references / Veo ASSET — not shown on
        # screen, square-ish so within the 0.40–2.50 aspect window). The full board is never fed to
        # the engine — that bled the whole collage onto each clip's first frame. Look consistency =
        # this character crop + the style/cast/voice text baked into each prompt. ──
        story_id = self._new_id("board-" + (title or "storyboard"))
        out_dir = GENERATIONS / story_id
        out_dir.mkdir(parents=True, exist_ok=True)
        (out_dir / f"source.{IMAGE_MIMES[mime]}").write_bytes(raw)
        char_ref = self._crop_char_reference(raw, char_box, out_dir / "ref01.jpg")
        ref_paths = [char_ref] if char_ref else []

        try:
            check_engine_key(tier)
        except RuntimeError as exc:
            shutil.rmtree(out_dir, ignore_errors=True)
            return self._json(503, {"error": str(exc)})

        job_id = uuid.uuid4().hex
        est = sum(engine_estimate(tier, resolution, s["duration"]) for s in scenes)
        if not self._charge(job_id, est, lambda: (shutil.rmtree(out_dir, ignore_errors=True),
                                                  auth.release(story_id)), "video", tier):
            return
        job_update(job_id, status="queued", detail="queued", genId=None, owner=self.user["id"], estCost=round(est, 4))
        args = {"scenes": scenes, "tier": tier, "resolution": resolution, "aspect": aspect,
                "title": (title or "Storyboard")[:200]}
        # text-to-video per clip, with the cropped character reference applied to all (no start frame)
        threading.Thread(target=_tracked(story_id, run_story), args=(job_id, story_id, args, []),
                         kwargs={"ref_paths": ref_paths}, daemon=True).start()
        self._json(202, {"jobId": job_id, "genId": story_id, "estCost": round(est * PRICE_MULTIPLIER, 4),
                         "sceneCount": len(scenes), "title": title, "hasCharRef": bool(ref_paths)})

    @staticmethod
    def _parse_storyboard_reply(reply: str, max_scenes: int, duration: int):
        """LLM text → (scenes, title, char_box). Returns ([], '', None) on any problem.

        The global `style` (art/cast/voice bible) is prepended to EVERY scene prompt, and `char_box`
        (fractional crop of the cleanest all-characters shot) becomes a visual reference fed to every
        clip — together they keep characters and narrator voice consistent without bleeding the whole
        storyboard onto each clip's first frame.

        Hardened: caps length before json.loads, tolerates code-fence wrapping, validates the shape,
        and copies ONLY the prompt/style strings + a numeric char_box (no dict spread — injected keys
        are dropped; char_box is range-checked, never used as a path)."""
        if not reply or len(reply) > 32 * 1024:
            return [], "", None
        text = reply.strip()
        if text.startswith("```"):                      # strip ```json … ``` fences if present
            text = re.sub(r"^```[a-zA-Z]*\n?", "", text)
            text = re.sub(r"\n?```$", "", text).strip()
        # fall back to the first {...} block if the model added stray prose
        if not text.startswith("{"):
            m = re.search(r"\{.*\}", text, re.DOTALL)
            if m:
                text = m.group(0)
        try:
            data = json.loads(text)
        except Exception:
            return [], "", None
        if not isinstance(data, dict):
            return [], "", None
        title = str(data.get("title", "")).strip()[:200]
        style = str(data.get("style", "")).strip()[:1500]   # global look/cast/voice lock
        char_box = Handler._sanitize_box(data.get("char_box"))
        raw_scenes = data.get("scenes")
        if not isinstance(raw_scenes, list):
            return [], "", None
        # appended to every clip so on-storyboard text/labels never get rendered into the video
        no_text = "No text overlays, captions, frame numbers, labels, logos or watermarks."
        scenes = []
        for s in raw_scenes[:max_scenes]:
            action = str((s or {}).get("prompt", "")).strip()[:6000] if isinstance(s, dict) else ""
            if not action:
                continue
            prompt = (style + "\n\n" + action) if style else action
            prompt = (prompt + "\n\n" + no_text)[:8000]
            scenes.append({"prompt": prompt, "duration": duration, "imageIndex": None})
        return scenes, title, char_box

    @staticmethod
    def _sanitize_box(box):
        """LLM char_box → 4 floats in [0,1] with x0<x1, y0<y1 and a sane minimum size, else None."""
        if not isinstance(box, (list, tuple)) or len(box) != 4:
            return None
        try:
            x0, y0, x1, y1 = (float(v) for v in box)
        except (TypeError, ValueError):
            return None
        x0, y0, x1, y1 = (max(0.0, min(1.0, v)) for v in (x0, y0, x1, y1))
        if x1 - x0 < 0.05 or y1 - y0 < 0.05:        # too small to be a useful reference
            return None
        return (x0, y0, x1, y1)

    @staticmethod
    def _crop_char_reference(raw: bytes, char_box, out_path: Path):
        """Crop the cleanest all-characters region → a clean reference image. Returns out_path or None.

        Re-encodes to JPEG (strips any malicious metadata), clamps aspect into OpenRouter's 0.40–2.50
        window, and caps the dimension to keep the payload small. char_box is numeric+range-checked
        upstream and is NEVER used to build a path — only pixel offsets."""
        if _PILImage is None or not char_box:
            return None
        try:
            import io
            im = _PILImage.open(io.BytesIO(raw)).convert("RGB")
            W, H = im.size
            x0, y0, x1, y1 = char_box
            L, T = int(x0 * W), int(y0 * H)
            R, B = int(x1 * W), int(y1 * H)
            L, T = max(0, min(L, W - 2)), max(0, min(T, H - 2))
            R, B = max(L + 1, min(R, W)), max(T + 1, min(B, H))
            crop = im.crop((L, T, R, B))
            w, h = crop.size
            ar = w / h
            if ar > 2.5:                                  # too wide → trim sides
                nw = int(h * 2.5); x = (w - nw) // 2; crop = crop.crop((x, 0, x + nw, h))
            elif ar < 0.4:                                # too tall → trim top/bottom
                nh = int(w / 0.4); y = (h - nh) // 2; crop = crop.crop((0, y, w, y + nh))
            crop.thumbnail((1024, 1024))
            out_path.parent.mkdir(parents=True, exist_ok=True)
            crop.save(out_path, "JPEG", quality=90)
            return out_path
        except Exception:
            return None

    def _story_resume(self):
        """Generate the pendingScenes of a partial story, then re-stitch the whole movie."""
        payload = self._json_body()
        if payload is None:
            return self._json(413, {"error": "request too large"})
        story_id = str(payload.get("id", ""))
        if not ID_RE.match(story_id):
            return self._json(400, {"error": "invalid id"})
        meta = _load_meta(story_id)
        if not meta or not self._can_access(story_id) or meta.get("kind") != "story":
            return self._json(404, {"error": "story not found"})
        pending = meta.get("pendingScenes") or []
        if meta.get("status") != "partial" or not pending:
            return self._json(400, {"error": "story has no pending scenes"})
        tier = meta.get("tier", "lite")
        if tier not in ENGINES:
            return self._json(400, {"error": "story uses an unknown engine"})
        if self._engine_denied(tier):
            return
        limit = allowed_durations(self.user)
        if limit:                                    # scenes saved before the limit existed may have other lengths
            pending = [{**s, "duration": snap_duration(s.get("duration", 8), limit)} for s in pending]
            for s in pending:
                dur_err = self._duration_error(tier, s["duration"])
                if dur_err:
                    return self._json(400, {"error": dur_err})
        try:
            check_engine_key(tier)
        except RuntimeError as exc:
            return self._json(503, {"error": str(exc)})

        # scene images (src01…) and character refs (ref01…) were saved at submit time
        image_paths = sorted((GENERATIONS / story_id).glob("src*"))
        ref_paths = sorted((GENERATIONS / story_id).glob("ref*"))
        args = {
            "scenes": pending,
            "tier": tier,
            "resolution": meta.get("resolution", "720p"),
            "aspect": meta.get("aspectRatio", "16:9"),
            "title": meta.get("prompt", "Story"),
        }
        job_id = uuid.uuid4().hex
        est = sum(engine_estimate(args["tier"], args["resolution"], s.get("duration", 8)) for s in pending)
        if not self._charge(job_id, est, None, "video", tier):
            return
        job_update(job_id, status="queued", detail="queued", genId=None, owner=self.user["id"], estCost=round(est, 4))
        threading.Thread(target=_tracked(story_id, run_story),
                         args=(job_id, story_id, args, image_paths),
                         kwargs={"prior_ids": meta.get("sourceIds") or [],
                                 "created_at": meta.get("createdAt"),
                                 "ref_paths": ref_paths},
                         daemon=True).start()
        self._json(202, {"jobId": job_id, "genId": story_id, "estCost": round(est * PRICE_MULTIPLIER, 4)})

    def _enhance(self):
        """Rewrite each scene's script into a Veo animation prompt via Claude Haiku."""
        payload = self._json_body()
        if payload is None:
            return self._json(413, {"error": "request too large"})
        raw_scenes = payload.get("scenes") or []
        raw_images = payload.get("images") or []
        if not isinstance(raw_scenes, list) or not (1 <= len(raw_scenes) <= MAX_SCENES):
            return self._json(400, {"error": f"need 1-{MAX_SCENES} scenes"})
        if not isinstance(raw_images, list) or len(raw_images) > MAX_STORY_IMAGES:
            return self._json(400, {"error": f"max {MAX_STORY_IMAGES} images"})
        if not self._guard("\n---\n".join(str((sc or {}).get("prompt", "")) for sc in raw_scenes), "enhance"):
            return
        try:
            api_key = load_anthropic_key()
        except RuntimeError as exc:
            return self._json(503, {"error": str(exc)})

        enhanced = []
        for i, s in enumerate(raw_scenes):
            text = str((s or {}).get("prompt", "")).strip()
            if not text or len(text) > 8000:
                return self._json(400, {"error": f"scene {i + 1}: prompt required (max 8000 chars)"})
            idx = s.get("imageIndex", None)
            img_b64 = img_mime = None
            if idx is not None:
                if not isinstance(idx, int) or not (0 <= idx < len(raw_images)):
                    return self._json(400, {"error": f"scene {i + 1}: imageIndex out of range"})
                img = raw_images[idx] or {}
                img_b64 = img.get("base64") or None
                img_mime = str(img.get("mime", "")).lower() or None
            try:
                enhanced.append(enhance_scene(api_key, text, img_b64, img_mime))
            except Exception as exc:
                return self._json(502, {"error": f"scene {i + 1}: {_redact(str(exc))[:300]}"})
        if not self._guard_output("\n---\n".join(enhanced), "enhance"):
            return
        self._json(200, {"prompts": enhanced})

    def _models(self):
        """Chat + image engines with whether this user may use them (drives the pickers in the UI)."""
        def listing(registry):
            return [{"id": k, "label": v["label"], "allowed": auth.engine_allowed(self.user, k),
                     "pictures": bool(v.get("vision") or v.get("ref"))} for k, v in registry.items()]
        self._json(200, {"chat": listing(openrouter_chat.CHAT_MODELS), "image": listing(openrouter_chat.IMAGE_MODELS)})

    def _reserve_sync(self, est: float):
        """Hold est USD for a synchronous call. Returns the reserved micro-USD, or None after sending a 402."""
        reserved, err = auth.reserve(self.user, est * PRICE_MULTIPLIER)
        if err:
            self._json(402, {"error": err})
            return None
        return reserved

    def _log_usage(self, kind: str, engine: str, provider_usd: float, reserved: int) -> None:
        """Usage row for a finished synchronous call: real provider cost vs what the user was charged (0 for admins/free)."""
        auth.record_usage(self.user["id"], kind, engine, provider_usd,
                          auth.to_micro(provider_usd * PRICE_MULTIPLIER) if reserved else 0)

    def _settle_sync(self, reserved: int, actual_usd: float) -> None:
        if reserved:                       # 0 = admin / free model → nothing was held
            auth.settle(self.user["id"], reserved, auth.to_micro(actual_usd * PRICE_MULTIPLIER))

    def _chat(self):
        """Kid-safe chat turn: guard every message → reserve → model → settle → scan the reply before returning it."""
        payload = self._json_body()
        if payload is None:
            return self._json(413, {"error": "request too large"})
        engine = str(payload.get("engine", "chat-deepseek"))
        if engine not in openrouter_chat.CHAT_MODELS:
            return self._json(400, {"error": "unknown chat model"})
        raw = payload.get("messages")
        if not isinstance(raw, list) or not 1 <= len(raw) <= 12:
            return self._json(400, {"error": "need 1-12 messages"})
        msgs, total = [], 0
        for m in raw:
            role = (m or {}).get("role") if isinstance(m, dict) else None
            content = str(m.get("content", "")).strip() if isinstance(m, dict) else ""
            if role not in ("user", "assistant") or not 1 <= len(content) <= 2000:
                return self._json(400, {"error": "each message needs a role (user/assistant) and 1-2000 characters"})
            total += len(content)
            msgs.append({"role": role, "content": content})
        if msgs[-1]["role"] != "user" or total > 8000:
            return self._json(400, {"error": "last message must be from the user (max 8000 characters in total)"})
        if self._engine_denied(engine):
            return
        for m in msgs:                      # history is client-supplied, so every turn is re-checked (verdicts cache)
            if not self._guard(m["content"], "chat"):
                return
        image = None
        if payload.get("image"):
            if not openrouter_chat.CHAT_MODELS[engine].get("vision"):
                return self._json(400, {"error": "This helper can't look at pictures. Pick the one that says "
                                                 "'can look at pictures'."})
            image = self._take_image(payload["image"], "chat")
            if image is False:
                return
        reserved = self._reserve_sync(openrouter_chat.estimate_chat_cost(engine, msgs, has_image=image is not None))
        if reserved is None:
            return
        try:
            text, cost = openrouter_chat.chat(engine, msgs, image=image)
        except Exception as exc:
            self._settle_sync(reserved, 0)
            print(f"chat error: {_redact(str(exc))[:200]}")
            return self._json(502, {"error": "Sunny is taking a short nap. Please try again in a moment."})
        self._settle_sync(reserved, cost)
        self._log_usage("chat", engine, cost, reserved)
        if not text:
            return self._json(502, {"error": "Sunny didn't have an answer that time. Try asking another way!"})
        verdict = safety.check(text)
        if not verdict.allowed:
            auth.record_violation(self.user, verdict.category or "other", "chat:output", text, strike=False)
            return self._json(200, {"reply": "Hmm, I can't share that one. Let's talk about something else — "
                                             "want a fun fact or a riddle?", "filtered": True})
        self._json(200, {"reply": text, "filtered": False})

    def _story_review(self):
        """Prompt Lab "Ask Sunny": guard the story → reserve → review → settle → scan the reply before returning it."""
        payload = self._json_body()
        if payload is None:
            return self._json(413, {"error": "request too large"})
        engine = str(payload.get("engine", "chat-deepseek"))
        if engine not in openrouter_chat.CHAT_MODELS:
            return self._json(400, {"error": "unknown chat model"})
        story = str(payload.get("story", "")).strip()
        if not 20 <= len(story) <= openrouter_chat.STORY_REVIEW_MAX:
            return self._json(400, {"error": f"write 20-{openrouter_chat.STORY_REVIEW_MAX} characters of story first"})
        if self._engine_denied(engine) or not self._guard(story, "story-review"):
            return
        reserved = self._reserve_sync(openrouter_chat.estimate_review_cost(engine, story))
        if reserved is None:
            return
        try:
            text, cost = openrouter_chat.review_story(engine, story)
        except Exception as exc:
            self._settle_sync(reserved, 0)
            print(f"story review error: {_redact(str(exc))[:200]}")
            return self._json(502, {"error": "Sunny is taking a short nap. Please try again in a moment."})
        self._settle_sync(reserved, cost)
        self._log_usage("chat", engine, cost, reserved)
        if not text:
            return self._json(502, {"error": "Sunny didn't have feedback that time. Try again!"})
        verdict = safety.check(text)
        if not verdict.allowed:
            auth.record_violation(self.user, verdict.category or "other", "story-review:output", text, strike=False)
            return self._json(200, {"reply": "Hmm, I can't share my thoughts on that one. Try a different story!", "filtered": True})
        self._json(200, {"reply": text, "filtered": False})

    def _image(self):
        """Text → image: guard the prompt → reserve → generate → settle → save as a library item."""
        payload = self._json_body()
        if payload is None:
            return self._json(413, {"error": "request too large"})
        engine = str(payload.get("engine", "img-seedream"))
        if engine not in openrouter_chat.IMAGE_MODELS:
            return self._json(400, {"error": "unknown image model"})
        prompt = str(payload.get("prompt", "")).strip()
        has_ref = bool(payload.get("ref"))
        if has_ref and not prompt:
            prompt = "Turn my drawing into a beautiful finished picture"
        if not 3 <= len(prompt) <= 1000:
            return self._json(400, {"error": "describe the picture in 3-1000 characters"})
        if has_ref and not openrouter_chat.IMAGE_MODELS[engine].get("ref"):
            return self._json(400, {"error": "This one can't use your drawing. Pick the model that says "
                                             "'can use your drawing'."})
        if self._engine_denied(engine) or not self._guard(prompt, "image"):
            return
        ref = self._take_image(payload.get("ref"), "image")
        if ref is False:
            return
        reserved = self._reserve_sync(openrouter_chat.IMAGE_MODELS[engine]["est"])
        if reserved is None:
            return
        try:
            raw, ext, cost = openrouter_chat.generate_image(engine, prompt, ref=ref)
        except Exception as exc:
            self._settle_sync(reserved, 0)
            print(f"image error: {_redact(str(exc))[:300]}")
            return self._json(502, {"error": "We couldn't draw that one. Try describing it a different way!"})
        self._settle_sync(reserved, cost)
        self._log_usage("image", engine, cost, reserved)
        gen_id = self._new_id("image-" + prompt)
        out_dir = GENERATIONS / gen_id
        out_dir.mkdir(parents=True, exist_ok=True)
        (out_dir / f"image.{ext}").write_bytes(raw)
        try:                                 # small thumbnail for the Library grid
            import io
            with _PILImage.open(io.BytesIO(raw)) as im:
                im = im.convert("RGB")
                im.thumbnail((420, 420))
                im.save(out_dir / "thumb.jpg", "JPEG", quality=80)
        except Exception:
            pass
        if ref is not None:                  # keep the (safety-checked) drawing next to its result; same owner
            (out_dir / "ref01.jpg").write_bytes(ref)
        (out_dir / "meta.json").write_text(json.dumps({
            "id": gen_id, "createdAt": datetime.now(timezone.utc).isoformat(), "kind": "image", "prompt": prompt,
            "engine": engine, "file": f"image.{ext}", "cost": round(cost, 4), "duration": 0,
            "hasReference": ref is not None,
        }, indent=2, ensure_ascii=False))
        self._json(200, {"genId": gen_id, "url": f"/generations/{gen_id}/image.{ext}", "cost": round(cost * PRICE_MULTIPLIER, 4)})

    def _stitch(self):
        payload = self._json_body()
        if payload is None:
            return self._json(413, {"error": "request too large"})
        ids = payload.get("ids") or []
        if not isinstance(ids, list) or not (2 <= len(ids) <= MAX_CLIPS_PER_STITCH):
            return self._json(400, {"error": f"need 2-{MAX_CLIPS_PER_STITCH} clip ids"})
        for cid in ids:
            if not isinstance(cid, str) or not ID_RE.match(cid):
                return self._json(400, {"error": "invalid clip id"})
            if not self._can_access(cid) or not (GENERATIONS / cid / "clip.mp4").is_file():
                return self._json(404, {"error": f"clip not found: {cid}"})
        gen_id = self._new_id("stitched-video")
        job_id = uuid.uuid4().hex
        job_update(job_id, status="queued", detail="queued", genId=None, owner=self.user["id"], estCost=0)
        threading.Thread(target=_tracked(gen_id, run_stitch), args=(job_id, gen_id, ids), daemon=True).start()
        self._json(202, {"jobId": job_id, "genId": gen_id})

    def _job(self, job_id: str):
        if not ID_RE.match(job_id or ""):
            return self._json(400, {"error": "invalid job id"})
        with JOBS_LOCK:
            job = dict(JOBS.get(job_id) or {})
        if not job or not (self.user["role"] == "admin" or job.get("owner") == self.user["id"]):
            return self._json(404, {"error": "unknown job"})
        for k in ("estCost", "cost"):                       # user-facing dollars (JOBS keeps the real provider cost)
            if isinstance(job.get(k), (int, float)):
                job[k] = round(job[k] * PRICE_MULTIPLIER, 4)
        for k in ("owner", "reserved", "settled"):         # internals
            job.pop(k, None)
        self._json(200, job)

    def _list(self):
        entries = []
        owners = auth.owner_map()
        if GENERATIONS.is_dir():
            for child in GENERATIONS.iterdir():
                if not child.is_dir() or not ID_RE.match(child.name):
                    continue
                if not auth.can_access(self.user, child.name, owners):
                    continue
                meta = _load_meta(child.name)
                if not meta:
                    continue
                frames = sorted((child / "frames").glob("f*.png"))
                images = sorted([p.name for p in child.glob("start.*")] +
                                [p.name for p in child.glob("src*.*") if p.suffix in (".png", ".jpg", ".webp")] +
                                [p.name for p in child.glob("ref*.*") if p.suffix in (".png", ".jpg", ".webp")])
                if isinstance(meta.get("cost"), (int, float)):
                    meta = {**meta, "cost": round(meta["cost"] * PRICE_MULTIPLIER, 4)}      # the file on disk keeps the real cost
                expires = video_expires_at(meta)
                if expires:
                    meta = {**meta, "expiresAt": expires}
                entries.append({
                    "id": child.name,
                    "meta": meta,
                    "thumb": (f"/generations/{child.name}/frames/{frames[0].name}" if frames else
                              (f"/generations/{child.name}/thumb.jpg" if (child / "thumb.jpg").is_file() else None)),
                    "images": [f"/generations/{child.name}/{n}" for n in images],
                })
        entries.sort(key=lambda e: e["meta"].get("createdAt", ""), reverse=True)
        self._json(200, entries)

    def _delete(self, gen_id: str):
        if not ID_RE.match(gen_id or ""):
            return self._json(400, {"error": "invalid id"})
        target = GENERATIONS / gen_id
        if not target.is_dir() or not self._can_access(gen_id):
            return self._json(404, {"error": "not found"})
        shutil.rmtree(target)
        auth.release(gen_id)
        self._json(200, {"ok": True})

    def _static_generation(self):
        # /generations/<id>/<file> — id regex + resolved-path containment
        parts = self.path.split("?", 1)[0].split("/")
        if len(parts) < 4 or not ID_RE.match(parts[2]):
            return self.send_error(400)
        if not self._can_access(parts[2]):
            return self.send_error(404)
        resolved = (GENERATIONS / "/".join(parts[2:])).resolve()
        if not str(resolved).startswith(str(GENERATIONS.resolve()) + "/") or not resolved.is_file():
            return self.send_error(404)
        return super().do_GET()

    # ── helpers ──────────────────────────────────────────────────────────────
    def _example_file(self, path: str):
        """/examples/<slug>/<file>: only mp4/jpg/png/webp inside a valid example folder — never example.json or anything else."""
        parts = path.split("?", 1)[0].split("/")                      # ['', 'examples', slug, file]
        if len(parts) != 4 or not EXAMPLE_SLUG_RE.match(parts[2]) or not EXAMPLE_FILE_RE.match(parts[3]):
            return self.send_error(404)
        target = EXAMPLES_DIR / parts[2] / parts[3]
        try:
            ok = target.is_file() and not target.is_symlink() and target.resolve().is_relative_to(EXAMPLES_DIR.resolve())
        except OSError:
            ok = False
        if not ok:
            return self.send_error(404)
        return super().do_GET()

    def translate_path(self, path):
        """Serve /generations/* from the (possibly relocated) data folder; everything else from the project folder."""
        clean = path.split("?", 1)[0].split("#", 1)[0]
        if clean.startswith("/examples/"):
            return str(EXAMPLES_DIR / posixpath.normpath(unquote(clean[len("/examples/"):])))
        if clean.startswith("/generations/"):
            rel = posixpath.normpath(unquote(clean[len("/generations/"):]))
            if rel.startswith(("..", "/")):
                return str(GENERATIONS / "__invalid__")
            return str(GENERATIONS / rel)
        return super().translate_path(path)

    def _client_ip(self) -> str:
        """The caller's address for rate limiting: the TCP peer, or — behind a trusted proxy — the address that proxy saw
        (the PROXY_HOPS-th entry from the right of X-Forwarded-For; entries further left are client-supplied)."""
        peer = self.client_address[0]
        if not TRUST_PROXY:
            return peer
        parts = [p.strip() for p in (self.headers.get("X-Forwarded-For") or "").split(",") if p.strip()]
        if len(parts) < PROXY_HOPS:
            return peer
        try:
            return str(ipaddress.ip_address(parts[-PROXY_HOPS]))
        except ValueError:
            return peer

    def _host_ok(self) -> bool:
        host = (self.headers.get("Host") or "").lower()
        if host in ALLOWED_HOSTS:
            return True
        if len(_REJECTED_HOSTS) < 50 and host not in _REJECTED_HOSTS:     # once per distinct value: a misconfiguration
            _REJECTED_HOSTS.add(host)                                      # shows up in the logs without letting bots flood them
            print(f"Rejected Host header {host[:100]!r} — add it to VIDEOGEN_PUBLIC_HOST "
                  f"(allowed now: {', '.join(sorted(h for h in ALLOWED_HOSTS if ':' not in h))})")
        self.send_error(403, "forbidden host")
        return False

    def _json_body(self):
        # require the real content-type: closes the classic CSRF bypass where a plain
        # <form enctype="text/plain"> POST (no preflight) smuggles a JSON-shaped body.
        ctype = (self.headers.get("Content-Type") or "").split(";")[0].strip().lower()
        if ctype != "application/json":
            return None
        try:
            length = int(self.headers.get("Content-Length", 0))
        except ValueError:
            return None
        if length > MAX_BODY:
            return None
        raw = self.rfile.read(length) if length else b"{}"
        try:
            data = json.loads(raw.decode("utf-8"))
            return data if isinstance(data, dict) else {}
        except Exception:
            return {}

    def _get_cookie(self, name: str) -> str:
        raw = self.headers.get("Cookie", "")
        for part in raw.split(";"):
            k, _, v = part.strip().partition("=")
            if k == name:
                return v
        return ""

    # ── auth: sessions, login, enrollment, admin ─────────────────────────────
    def _authed(self) -> bool:
        sid = self._get_cookie(SESSION_COOKIE)
        self.user = auth.get_session(sid) if sid else None
        return self.user is not None

    def _cookie(self, name: str, value: str, max_age: int) -> str:
        return (f"{name}={value}; Path=/; HttpOnly; SameSite=Strict; Max-Age={max_age}"
                + ("; Secure" if COOKIE_SECURE else ""))

    def _html(self, code: int, body: str, cookies: tuple = (), framable: bool = False):
        data = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        # only the admin screen embedded in our own app shell may be framed — and only by this same origin
        self.send_header("X-Frame-Options", "SAMEORIGIN" if framable else "DENY")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Security-Policy",
                         f"default-src 'none'; script-src {auth.SCRIPT_SRC}; style-src 'unsafe-inline'; img-src 'self' data:; "
                         f"form-action 'self'; frame-ancestors {chr(39)}{'self' if framable else 'none'}{chr(39)}")
        for c in cookies:
            self.send_header("Set-Cookie", c)
        self.end_headers()
        self.wfile.write(data)

    def _redirect(self, location: str, cookies: tuple = ()):
        self.send_response(302)
        self.send_header("Location", location)
        self.send_header("Content-Length", "0")
        self.send_header("Cache-Control", "no-store")
        for c in cookies:
            self.send_header("Set-Cookie", c)
        self.end_headers()

    def _form(self) -> dict | None:
        """Small urlencoded form body → {field: first value}; None if oversized/wrong type."""
        ctype = (self.headers.get("Content-Type") or "").split(";")[0].strip().lower()
        try:
            length = int(self.headers.get("Content-Length", 0))
        except ValueError:
            return None
        if ctype != "application/x-www-form-urlencoded" or not 0 <= length <= 4096:
            return None
        form = parse_qs(self.rfile.read(length).decode("utf-8", "replace"))
        out = {k: v[0] for k, v in form.items()}
        out["_all"] = form                      # multi-value fields (engine checkboxes)
        return out

    def _origin(self) -> str:
        return f"{'https' if COOKIE_SECURE else 'http'}://{self.headers.get('Host', '')}"

    def _public_file(self, entry: tuple):
        name, ctype = entry                               # from the PUBLIC_UI_FILES allow-list, never from the request
        data = (ROOT / "ui" / name).read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "public, max-age=86400")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(data)

    def _login_post(self):
        form = self._form()
        if form is None:
            return self._html(400, auth.login_page("Invalid request."))
        pid, err = auth.login_step1(form.get("username", ""), form.get("password", ""), self._client_ip())
        if err == "limited":
            return self._html(429, auth.login_page("Too many attempts — try again in a few minutes."))
        if err:
            return self._html(401, auth.login_page("Incorrect username or password."))
        self._redirect("/login/2fa", (self._cookie(PENDING_COOKIE, pid, auth.PENDING_TTL),))

    def _totp_post(self):
        form = self._form()
        if form is None:
            return self._html(400, auth.totp_page("Invalid request."))
        sid, err = auth.login_step2(self._get_cookie(PENDING_COOKIE), form.get("code", ""), self._client_ip())
        if err == "expired":
            return self._redirect("/login", (self._cookie(PENDING_COOKIE, "", 0),))
        if err == "limited":
            return self._html(429, auth.totp_page("Too many attempts — try again in a few minutes."))
        if err:
            return self._html(401, auth.totp_page("Incorrect code."))
        self._redirect("/", (self._cookie(SESSION_COOKIE, sid, auth.SESSION_TTL),
                             self._cookie(PENDING_COOKIE, "", 0)))

    def _enroll_post(self, token: str):
        user = auth.enrollment_user(token)
        if not user:
            return self._html(404, auth.login_page("This setup link was already used, replaced by a newer one, or has expired. If you already finished setting up, just sign in; otherwise ask your admin for a new link."))
        form = self._form()
        if form is None:
            return self._html(400, auth.enroll_page(token, user, "Invalid request."))
        err = auth.complete_enrollment(token, form.get("password", ""), form.get("code", ""),
                                       self._client_ip())
        if err:
            return self._html(400, auth.enroll_page(token, user, err))
        self._html(200, auth.done_page())

    def _index(self):
        """Serve the SPA with the signed-in user injected (username is regex-restricted, so safe in a script)."""
        page = (ROOT / "ui" / "VideoGen.html").read_text(encoding="utf-8")
        who = json.dumps({"username": self.user["username"], "role": self.user["role"], "priceMultiplier": PRICE_MULTIPLIER,
                          "videoRetentionHours": VIDEO_RETENTION_HOURS,
                          "allowedDurations": list(allowed_durations(self.user) or []) or None})
        data = page.replace("<head>", f"<head><script>window.VG_USER={who};</script>", 1).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def _admin_html(self, code: int, notice: str = "", link: str = "", error: str = ""):
        """Render the admin screen; `?embed=1` renders the compact version used inside the app's right-hand pane."""
        embed = "embed=1" in self.path.partition("?")[2].split("&")
        self._html(code, auth.admin_page(self.user, notice, link, error, embed=embed), framable=embed)

    def _admin_get(self):
        if self.user["role"] != "admin":
            return self.send_error(404)
        self._admin_html(200)

    def _admin_post(self):
        """POST /admin/users (create) and /admin/users/<id>/(disable|enable|reset|credits|limits). Admin + CSRF token."""
        if self.user["role"] != "admin":
            return self.send_error(404)
        form = self._form()
        if form is None or not auth.csrf_ok(self.user, form.get("csrf", "")):
            return self._admin_html(403, error="Invalid or expired form — reload and retry.")
        parts = self.path.split("?", 1)[0].strip("/").split("/")      # ["admin","users"(,"<id>","<action>")]
        if parts == ["admin", "users"]:
            try:
                _, token = auth.create_user(form.get("username", ""), form.get("role", "user"))
            except ValueError as exc:
                return self._admin_html(400, error=str(exc))
            return self._admin_html(200, "User created.", f"{self._origin()}/enroll/{token}")
        if len(parts) == 4 and parts[:2] == ["admin", "users"] and parts[2].isdigit() and int(parts[2]) != self.user["id"]:
            uid, action = int(parts[2]), parts[3]
            if action in ("disable", "enable"):
                auth.set_disabled(uid, action == "disable")
                return self._admin_html(200, f"User {action}d.")
            if action == "credits":
                amount = auth.parse_amount(form.get("amount", ""))
                if not amount or not auth.add_credits(uid, amount, self.user["id"]):
                    return self._admin_html(400, error="Enter an amount above 0 (max $10,000).")
                return self._admin_html(200, f"Added {auth.usd(amount)}.")
            if action == "time":
                minutes = auth.parse_minutes(form.get("minutes", ""), auth.MAX_BONUS_MINUTES)
                if minutes is None:
                    return self._admin_html(400, error=f"Enter whole minutes from 0 to {auth.MAX_BONUS_MINUTES}.")
                if (auth.time_status(uid) or {}).get("limitMin") == 0:
                    return self._admin_html(400, error="This user has no daily time limit yet — set one under "
                                                       "'Daily screen time' first, then extra time makes sense.")
                if not auth.set_bonus(uid, minutes):
                    return self._admin_html(400, error="Could not save that.")
                return self._admin_html(200, f"Extra time for today set to {minutes} min." if minutes else "Extra time removed.")
            if action == "limits":
                cap = auth.parse_amount(form.get("daily_cap", "0") or "0")
                raw_minutes = form.get("daily_minutes")                     # absent → leave the time limit unchanged
                minutes = None if raw_minutes is None else auth.parse_minutes(raw_minutes or "0", auth.MAX_DAILY_MINUTES)
                if (cap is None or (raw_minutes is not None and minutes is None)
                        or not auth.set_limits(uid, cap, form["_all"].get("engine", []), minutes)):
                    return self._admin_html(400, error="Daily cap must be 0-10,000, daily time 0-1440 minutes, and at "
                                                       "least one engine must be allowed.")
                return self._admin_html(200, "Limits saved.")
            if action == "reset":
                token = auth.reset_user(uid)
                if token:
                    return self._admin_html(200, "Reset — old sessions revoked.", f"{self._origin()}/enroll/{token}")
        self.send_error(404)

    def _logout(self):
        auth.destroy_session(self._get_cookie(SESSION_COOKIE))
        self._redirect("/login", (self._cookie(SESSION_COOKIE, "", 0),))

    def _guard(self, text: str, source: str) -> bool:
        """Safety gate for user text — call BEFORE any spend or file write. Sends 422 and returns False if blocked.

        Blocks are logged (category + short excerpt) and counted as strikes; the 3rd strike in 24 h — or any
        sexual content involving minors — suspends a non-admin account. Self-harm gets a supportive message and
        no strike. The user only ever sees a generic message, never which rule matched."""
        return self._enforce(safety.check(text), text, source)

    def _enforce(self, verdict, logged_text: str, source: str) -> bool:
        if verdict.allowed:
            return True
        suspended = False
        if verdict.source != "error":
            suspended = auth.record_violation(
                self.user, verdict.category, source, logged_text, strike=verdict.category != safety.SELF_HARM,
                immediate=verdict.category in safety.ZERO_TOLERANCE)
        self._json(422, {"error": safety.message_for(verdict, suspended), "blocked": True})
        return False

    def _take_image(self, obj, source: str):
        """Validate, sanitise and safety-check a picture the user attached ({mime, base64}).

        Returns clean JPEG bytes, None when nothing was attached, or False after sending an error response.
        The upload is decoded strictly, sniffed by magic bytes, re-encoded (strips EXIF/GPS and any hidden payload,
        caps the size) and must pass the vision safety check before anything else touches it."""
        if not obj:
            return None
        if _PILImage is None:
            self._json(503, {"error": "Pictures aren't available on this server."})
            return False
        mime = str((obj or {}).get("mime", "")).lower() if isinstance(obj, dict) else ""
        b64 = (obj or {}).get("base64") if isinstance(obj, dict) else None
        if mime not in IMAGE_MIMES or not isinstance(b64, str) or len(b64) > UPLOAD_MAX_BYTES * 4 // 3 + 100:
            self._json(400, {"error": f"Attach a PNG, JPEG or WebP picture smaller than {UPLOAD_MAX_BYTES // 2**20} MB."})
            return False
        try:
            raw = base64.b64decode(b64.split(",", 1)[1] if "," in b64[:100] else b64, validate=True)
            if not raw or len(raw) >= UPLOAD_MAX_BYTES:
                raise ValueError("size")
            if not (raw.startswith((b"\x89PNG\r\n\x1a\n", b"\xff\xd8\xff")) or (raw[:4] == b"RIFF" and raw[8:12] == b"WEBP")):
                raise ValueError("not an image")
            import io
            from PIL import ImageOps
            im = _PILImage.open(io.BytesIO(raw))
            im.load()                                           # raises on decompression bombs / truncated files
            im = ImageOps.exif_transpose(im)
            if im.mode in ("RGBA", "LA", "P"):                  # flatten transparency onto white
                im = im.convert("RGBA")
                bg = _PILImage.new("RGB", im.size, "white")
                bg.paste(im, mask=im.split()[-1])
                im = bg
            else:
                im = im.convert("RGB")
            im.thumbnail((1536, 1536))
            out = io.BytesIO()
            im.save(out, "JPEG", quality=88, optimize=True)     # re-encode: no metadata, no polyglot
            jpeg = out.getvalue()
        except Exception:
            self._json(400, {"error": "We couldn't read that picture. Try a different one!"})
            return False
        if auth.upload_limited(self.user["id"]):
            self._json(429, {"error": "That's a lot of pictures! Please wait a little before adding more."})
            return False
        if not self._enforce(safety.check_image(jpeg), "[picture]", source + ":picture"):
            return False
        return jpeg

    def _guard_output(self, text: str, source: str) -> bool:
        """Local-filter scan of AI-written text before the user sees it. Logged without a strike (not the user's doing)."""
        category = safety.local_check(text)
        if not category:
            return True
        auth.record_violation(self.user, category, source + ":output", text, strike=False)
        self._json(502, {"error": "We couldn't write that one. Let's try a different idea!"})
        return False

    def _duration_error(self, tier: str, duration: int) -> str | None:
        """Why this clip length isn't allowed for the current user on this engine (None = fine)."""
        limit = allowed_durations(self.user)
        if limit and duration not in limit:
            return "Clips can be " + " or ".join(str(d) for d in limit) + " seconds long."
        if not valid_duration(tier, duration):
            return (f"This engine can't make {duration}-second clips — pick a Seedance engine." if limit else "invalid duration")
        return None

    def _engine_denied(self, tier: str) -> bool:
        """403 (and True) when this user's engine allow-list excludes the tier."""
        if auth.engine_allowed(self.user, tier):
            return False
        self._json(403, {"error": f"You don't have access to the '{tier}' engine."})
        return True

    def _out_of_credits(self) -> bool:
        """Cheap early 402 so a zero-balance user can't trigger paid pre-processing (e.g. storyboard vision)."""
        if self.user["role"] == "admin" or auth.account(self.user["id"])["balance"] > 0:
            return False
        self._json(402, {"error": "You have no credits left. Ask an admin to add credits."})
        return True

    def _charge(self, job_id: str, est: float, cleanup=None, kind: str = "video", engine: str = "") -> bool:
        """Reserve est USD from the user's credits; on refusal run cleanup, send 402 and return False."""
        reserved, err = auth.reserve(self.user, est * PRICE_MULTIPLIER)
        if err:
            if cleanup:
                cleanup()
            self._json(402, {"error": err})
            return False
        job_update(job_id, reserved=reserved, kind=kind, engine=engine)      # reserved is 0 for admins / free models
        return True

    def _ping(self):
        """Activity check-in from the open, visible, in-use page (every ~30 s). Returns today's time status."""
        self._json(200, auth.touch(self.user["id"]) or {})

    def _me(self):
        acc = auth.account(self.user["id"])
        self._json(200, {"username": self.user["username"], "role": self.user["role"],
                         "unmetered": self.user["role"] == "admin",
                         "balance": acc["balance"] / auth.MICRO, "dailyCap": acc["daily_cap"] / auth.MICRO,
                         "spentToday": acc["spent_today"] / auth.MICRO, "engines": acc["engines"],
                         "time": auth.time_status(self.user["id"]), "priceMultiplier": PRICE_MULTIPLIER,
                         "videoRetentionHours": VIDEO_RETENTION_HOURS,
                         "allowedDurations": list(allowed_durations(self.user) or []) or None})

    def _new_id(self, prompt: str) -> str:
        """make_id + record the current user as owner (story clips '<id>-cNN' inherit it)."""
        gen_id = make_id(prompt)
        auth.claim(gen_id, self.user["id"])
        return gen_id

    def _can_access(self, gen_id: str) -> bool:
        return auth.can_access(self.user, gen_id)

    def _json(self, code: int, payload: dict):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        pass


if __name__ == "__main__":
    GENERATIONS.mkdir(exist_ok=True)
    try:
        veo.load_api_key()
        print("Gemini API key (Veo): found")
    except RuntimeError as exc:
        print(f"Gemini API key (Veo): MISSING — {exc}")
    try:
        openrouter_video.load_api_key()
        print("OpenRouter API key (Grok/Seedance): found")
    except RuntimeError as exc:
        print(f"OpenRouter API key (Grok/Seedance): MISSING — {exc}")
    try:
        ark_video.load_api_key()
        print("BytePlus Ark API key (direct Seedance): found")
    except RuntimeError as exc:
        print(f"BytePlus Ark API key (direct Seedance): MISSING — {exc}")
    sys.stdout.reconfigure(line_buffering=True)    # startup lines (incl. the setup link) reach server.log immediately
    auth.init_db()
    for warning in startup_warnings(os.environ.get("VIDEOGEN_RESET_ADMIN") == "1", auth.DATA_DIR,
                                    bool(os.environ.get("VIDEOGEN_DATA_DIR"))):
        print(warning)
    token = auth.bootstrap_admin(force=os.environ.get("VIDEOGEN_RESET_ADMIN") == "1")
    if token:    # one-time, expires in 24 h — consumed on use. Treat server.log as sensitive until then.
        first = (_public_hosts or ["127.0.0.1"])[0]
        if COOKIE_SECURE:                                  # served over HTTPS (own TLS or a proxy): bare domain, no port
            base = f"https://{first}"
        else:
            base = f"{'https' if os.environ.get('VIDEOGEN_TLS_CERT') else 'http'}://{first}:{PORT}"
        print(f"ADMIN SETUP (one-time link, 24 h): {base}/enroll/{token}")
        print("  (every restart issues a NEW link until the admin finishes setup — always use the LAST one in the log)")
    else:
        print("Admin account is already set up — sign in at /login with username 'admin'. No setup link is printed.")
    print("Sign-in: username + password + authenticator code (accounts in users.db)")
    print(f"Price multiplier: x{PRICE_MULTIPLIER:g} (VIDEOGEN_PRICE_MULTIPLIER) — credits and shown prices = provider cost x this")
    if VIDEO_RETENTION_HOURS > 0:
        pending = purge_expired_videos(dry_run=True)
        print(f"Video retention: videos are deleted {VIDEO_RETENTION_HOURS:g} h after they are made (pictures and scripts are kept). "
              f"{len(pending)} existing video(s) are already past that and will be removed within the first cleanup.")
        start_retention_thread()
    else:
        print("Video retention: off (set VIDEOGEN_VIDEO_RETENTION_HOURS=48 to delete videos 48 h after they are made).")
    print(f"Clip lengths for ordinary users: {', '.join(map(str, USER_DURATIONS)) + ' s' if USER_DURATIONS else 'any'} "
          f"(VIDEOGEN_USER_DURATIONS; admins are never limited)")
    print(f"Public hosts accepted: {', '.join(_public_hosts) or '(none — only localhost)'}")
    print(f"Open → http://127.0.0.1:{PORT}/")
    httpd = ThreadingHTTPServer((BIND_ADDR, PORT), Handler)
    cert, key = os.environ.get("VIDEOGEN_TLS_CERT"), os.environ.get("VIDEOGEN_TLS_KEY")
    if cert and key:                     # HTTPS (needed for the microphone on non-localhost addresses)
        import ssl
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.minimum_version = ssl.TLSVersion.TLSv1_2
        ctx.load_cert_chain(cert, key)
        httpd.socket = ctx.wrap_socket(httpd.socket, server_side=True)
        print("HTTPS enabled — also set VIDEOGEN_COOKIE_SECURE=1")
    httpd.serve_forever()
