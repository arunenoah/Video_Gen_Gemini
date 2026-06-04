#!/usr/bin/env python3
"""VideoGen local server — threaded HTTP server + Veo job runner + archive.

Security posture:
- Binds 127.0.0.1 only; Host header validated (DNS-rebinding guard).
- API key lives server-side only (env / ~/.gemini_api_key) — never sent to the browser.
- All id params validated against a strict regex (path-traversal guard).
- Upload: MIME allow-list + size cap; request bodies capped.
- ffmpeg invoked with array args only.
"""

import json
import base64
import os
import re
import shutil
import threading
import uuid
from datetime import datetime, timezone
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from urllib import request as urllib_request
from urllib.error import HTTPError

import veo
import openrouter_video

PORT = 8767
ROOT = Path(__file__).resolve().parent
GENERATIONS = ROOT / "generations"
ID_RE = re.compile(r"^[A-Za-z0-9_\-]+$")
SLUG_RE = re.compile(r"[^a-z0-9]+")
MAX_BODY = 60 * 1024 * 1024          # 60 MB (story mode: several base64 images)
IMAGE_MIMES = {"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp"}
MAX_CLIPS_PER_STITCH = 30
MAX_SCENES = 20
MAX_STORY_IMAGES = 10
ALLOWED_HOSTS = {f"127.0.0.1:{PORT}", f"localhost:{PORT}"}

JOBS: dict[str, dict] = {}            # in-memory job state
JOBS_LOCK = threading.Lock()

# ── engine registry: tier id → provider + per-engine constraints ─────────────
# Veo tier ids (lite/fast/quality) stay unchanged for backward compatibility.
ENGINES = {
    "lite":     {"provider": "veo",        "resolutions": {"720p", "1080p"}},
    "fast":     {"provider": "veo",        "resolutions": {"720p", "1080p"}},
    "quality":  {"provider": "veo",        "resolutions": {"720p", "1080p"}},
    "grok":     {"provider": "openrouter", "resolutions": {"480p", "720p"}},
    "seedance": {"provider": "openrouter", "resolutions": {"720p", "1080p"}},
}
DURATIONS = (4, 6, 8)                 # shared clip lengths, valid on every engine


def validate_engine(tier: str, resolution: str) -> str | None:
    """Returns an error message, or None when tier+resolution are valid."""
    spec = ENGINES.get(tier)
    if spec is None:
        return "invalid tier"
    if resolution not in spec["resolutions"]:
        return f"{tier} supports {sorted(spec['resolutions'])} only"
    return None


def check_engine_key(tier: str) -> None:
    """Raises RuntimeError when the engine's API key is missing."""
    if ENGINES[tier]["provider"] == "openrouter":
        openrouter_video.load_api_key()
    else:
        veo.load_api_key()


def engine_estimate(tier: str, resolution: str, duration: int) -> float:
    if ENGINES[tier]["provider"] == "openrouter":
        return openrouter_video.estimate_cost(tier, resolution, duration)
    return veo.estimate_cost(tier, resolution, duration)


def engine_generate(tier: str, prompt: str, out_dir: Path, *, image_path: Path | None,
                    resolution: str, duration: int, progress) -> dict:
    """Dispatch one clip generation to the engine's provider module."""
    if ENGINES[tier]["provider"] == "openrouter":
        return openrouter_video.generate_clip(
            prompt, out_dir, engine=tier, image_path=image_path,
            resolution=resolution, duration=duration, progress=progress)
    return veo.generate_clip(
        prompt, out_dir, image_path=image_path,
        tier=tier, resolution=resolution, duration=duration, progress=progress)


def make_id(prompt: str) -> str:
    ts = datetime.now().strftime("%Y%m%d-%H%M%S")
    slug = SLUG_RE.sub("-", (prompt or "").lower())[:40].strip("-") or "untitled"
    return f"{ts}-{slug}-{uuid.uuid4().hex[:6]}"


def job_update(job_id: str, **fields) -> None:
    with JOBS_LOCK:
        JOBS.setdefault(job_id, {}).update(fields)


def run_generation(job_id: str, gen_id: str, payload: dict, image_path: Path | None) -> None:
    out_dir = GENERATIONS / gen_id
    try:
        meta = engine_generate(
            payload["tier"], payload["prompt"], out_dir,
            image_path=image_path,
            resolution=payload["resolution"], duration=payload["duration"],
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
                    resolution: str, pending: list[dict], created_at: str | None = None) -> dict:
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
        "duration": sum(m.get("duration", 0) for m in clip_metas),
        "cost": round(sum(m.get("cost", 0) for m in clip_metas), 4),
        "clipPath": "clip.mp4",
    }
    (out_dir / "meta.json").write_text(json.dumps(meta, indent=2, ensure_ascii=False))
    return meta


def run_story(job_id: str, story_id: str, payload: dict, image_paths: list[Path],
              prior_ids: list[str] | None = None, created_at: str | None = None) -> None:
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
                               pending=[], created_at=created_at)
        job_update(job_id, status="done", detail="done", genId=story_id, cost=meta["cost"])
    except Exception as exc:
        err = _redact(str(exc))[:300]
        if clip_ids:  # save a playable partial story + what's left to generate
            pending = scenes[new_done:]
            try:
                job_update(job_id, status="running", detail="rate limited — stitching partial story")
                meta = _finalize_story(story_id, clip_ids, title, payload["tier"], payload["resolution"],
                                       pending=pending, created_at=created_at)
                job_update(job_id, status="done", genId=story_id, cost=meta["cost"], partial=True,
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
        key_file = Path.home() / ".anthropic_api_key"
        if key_file.is_file():
            key = key_file.read_text().strip()
    if not key:
        raise RuntimeError(
            "No Anthropic key. Add it to config.json, set ANTHROPIC_API_KEY, or create "
            "~/.anthropic_api_key (chmod 600) to use ✨ Enhance."
        )
    return key


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


def _load_meta(gen_id: str) -> dict:
    try:
        return json.loads((GENERATIONS / gen_id / "meta.json").read_text())
    except Exception:
        return {}


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    # ── routing ──────────────────────────────────────────────────────────────
    def do_GET(self):
        if not self._host_ok():
            return
        # config.json holds API keys — server-side only, never served over HTTP
        if self.path.split("?", 1)[0] == "/config.json":
            return self.send_error(404)
        if self.path == "/":
            self.path = "/ui/VideoGen.html"       # kid-friendly tabbed UI (design handoff)
            return super().do_GET()
        if self.path == "/classic":
            self.path = "/video-generator.html"   # original dark single-page UI
            return super().do_GET()
        if self.path == "/api/list":
            return self._list()
        if self.path.startswith("/api/job/"):
            return self._job(self.path[len("/api/job/"):])
        if self.path.startswith("/generations/"):
            return self._static_generation()
        return super().do_GET()

    def do_POST(self):
        if not self._host_ok():
            return
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
        if self.path == "/api/stitch":
            return self._stitch()
        self.send_error(404)

    def do_DELETE(self):
        if not self._host_ok():
            return
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
        try:
            duration = int(payload.get("duration", 8))
        except (TypeError, ValueError):
            duration = 0
        if not prompt or len(prompt) > 8000:
            return self._json(400, {"error": "prompt required (max 8000 chars)"})
        engine_err = validate_engine(tier, resolution)
        if engine_err or duration not in DURATIONS:
            return self._json(400, {"error": engine_err or "invalid duration"})

        gen_id = make_id(prompt)
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

        try:
            check_engine_key(tier)
        except RuntimeError as exc:
            return self._json(503, {"error": str(exc)})

        job_id = uuid.uuid4().hex
        job_update(job_id, status="queued", detail="queued", genId=None,
                   estCost=engine_estimate(tier, resolution, duration))
        args = {"prompt": prompt, "tier": tier, "resolution": resolution, "duration": duration}
        threading.Thread(target=run_generation, args=(job_id, gen_id, args, image_path),
                         daemon=True).start()
        self._json(202, {"jobId": job_id, "genId": gen_id})

    def _story(self):
        payload = self._json_body()
        if payload is None:
            return self._json(413, {"error": "request too large"})

        tier = str(payload.get("tier", "lite"))
        resolution = str(payload.get("resolution", "720p"))
        engine_err = validate_engine(tier, resolution)
        if engine_err:
            return self._json(400, {"error": engine_err})

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
            if duration not in DURATIONS:
                return self._json(400, {"error": f"scene {i + 1}: duration must be 4, 6 or 8"})
            idx = s.get("imageIndex", None)
            if idx is not None:
                if not isinstance(idx, int) or not (0 <= idx < len(raw_images)):
                    return self._json(400, {"error": f"scene {i + 1}: imageIndex out of range"})
            scenes.append({"prompt": prompt, "duration": duration, "imageIndex": idx})

        story_id = make_id(payload.get("title") or "story")
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

        try:
            check_engine_key(tier)
        except RuntimeError as exc:
            shutil.rmtree(out_dir, ignore_errors=True)
            return self._json(503, {"error": str(exc)})

        job_id = uuid.uuid4().hex
        est = sum(engine_estimate(tier, resolution, s["duration"]) for s in scenes)
        job_update(job_id, status="queued", detail="queued", genId=None, estCost=round(est, 4))
        args = {"scenes": scenes, "tier": tier, "resolution": resolution,
                "title": str(payload.get("title") or "")[:200]}
        threading.Thread(target=run_story, args=(job_id, story_id, args, image_paths),
                         daemon=True).start()
        self._json(202, {"jobId": job_id, "genId": story_id, "estCost": round(est, 4)})

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

        # archive the paid output — scripts are history too
        gid = make_id("script-" + idea)
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
        self._json(200, {"script": script})

    def _story_resume(self):
        """Generate the pendingScenes of a partial story, then re-stitch the whole movie."""
        payload = self._json_body()
        if payload is None:
            return self._json(413, {"error": "request too large"})
        story_id = str(payload.get("id", ""))
        if not ID_RE.match(story_id):
            return self._json(400, {"error": "invalid id"})
        meta = _load_meta(story_id)
        if not meta or meta.get("kind") != "story":
            return self._json(404, {"error": "story not found"})
        pending = meta.get("pendingScenes") or []
        if meta.get("status") != "partial" or not pending:
            return self._json(400, {"error": "story has no pending scenes"})
        tier = meta.get("tier", "lite")
        if tier not in ENGINES:
            return self._json(400, {"error": "story uses an unknown engine"})
        try:
            check_engine_key(tier)
        except RuntimeError as exc:
            return self._json(503, {"error": str(exc)})

        # reference images were saved into the story folder at submit time (src01, src02…)
        image_paths = sorted((GENERATIONS / story_id).glob("src*"))
        args = {
            "scenes": pending,
            "tier": tier,
            "resolution": meta.get("resolution", "720p"),
            "title": meta.get("prompt", "Story"),
        }
        job_id = uuid.uuid4().hex
        est = sum(engine_estimate(args["tier"], args["resolution"], s.get("duration", 8)) for s in pending)
        job_update(job_id, status="queued", detail="queued", genId=None, estCost=round(est, 4))
        threading.Thread(target=run_story,
                         args=(job_id, story_id, args, image_paths),
                         kwargs={"prior_ids": meta.get("sourceIds") or [],
                                 "created_at": meta.get("createdAt")},
                         daemon=True).start()
        self._json(202, {"jobId": job_id, "genId": story_id, "estCost": round(est, 4)})

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
        self._json(200, {"prompts": enhanced})

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
            if not (GENERATIONS / cid / "clip.mp4").is_file():
                return self._json(404, {"error": f"clip not found: {cid}"})
        gen_id = make_id("stitched-video")
        job_id = uuid.uuid4().hex
        job_update(job_id, status="queued", detail="queued", genId=None, estCost=0)
        threading.Thread(target=run_stitch, args=(job_id, gen_id, ids), daemon=True).start()
        self._json(202, {"jobId": job_id, "genId": gen_id})

    def _job(self, job_id: str):
        if not ID_RE.match(job_id or ""):
            return self._json(400, {"error": "invalid job id"})
        with JOBS_LOCK:
            job = dict(JOBS.get(job_id) or {})
        if not job:
            return self._json(404, {"error": "unknown job"})
        self._json(200, job)

    def _list(self):
        entries = []
        if GENERATIONS.is_dir():
            for child in GENERATIONS.iterdir():
                if not child.is_dir() or not ID_RE.match(child.name):
                    continue
                meta = _load_meta(child.name)
                if not meta:
                    continue
                frames = sorted((child / "frames").glob("f*.png"))
                images = sorted([p.name for p in child.glob("start.*")] +
                                [p.name for p in child.glob("src*.*") if p.suffix in (".png", ".jpg", ".webp")])
                entries.append({
                    "id": child.name,
                    "meta": meta,
                    "thumb": f"/generations/{child.name}/frames/{frames[0].name}" if frames else None,
                    "images": [f"/generations/{child.name}/{n}" for n in images],
                })
        entries.sort(key=lambda e: e["meta"].get("createdAt", ""), reverse=True)
        self._json(200, entries)

    def _delete(self, gen_id: str):
        if not ID_RE.match(gen_id or ""):
            return self._json(400, {"error": "invalid id"})
        target = GENERATIONS / gen_id
        if not target.is_dir():
            return self._json(404, {"error": "not found"})
        shutil.rmtree(target)
        self._json(200, {"ok": True})

    def _static_generation(self):
        # /generations/<id>/<file> — id regex + resolved-path containment
        parts = self.path.split("?", 1)[0].split("/")
        if len(parts) < 4 or not ID_RE.match(parts[2]):
            return self.send_error(400)
        resolved = (GENERATIONS / "/".join(parts[2:])).resolve()
        if not str(resolved).startswith(str(GENERATIONS.resolve()) + "/") or not resolved.is_file():
            return self.send_error(404)
        return super().do_GET()

    # ── helpers ──────────────────────────────────────────────────────────────
    def _host_ok(self) -> bool:
        host = (self.headers.get("Host") or "").lower()
        if host in ALLOWED_HOSTS:
            return True
        self.send_error(403, "forbidden host")
        return False

    def _json_body(self):
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
    print(f"Open → http://127.0.0.1:{PORT}/")
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
