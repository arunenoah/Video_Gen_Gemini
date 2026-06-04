# VideoGen — AI Video Generator (Veo 3.1)

Local browser tool: write a prompt (optionally drop a starting-frame image), pick a model tier, get an MP4 with native audio — voices, dialogue, ambience. Every run is archived with prompt, cost and preview frames. Modeled on the `Info/` infographic generator.

## Quick start

```bash
cd VideoGen
python3.12 -m venv .venv && ./.venv/bin/pip install google-genai   # once
cp config.example.json config.json     # then paste your 2 keys (git-ignored)
./.venv/bin/python server.py           # starts on http://127.0.0.1:8767
```

Key lookup order (both providers): env var → `config.json` → `~/.gemini_api_key` / `~/.anthropic_api_key`.
`config.json` is read **server-side only** and explicitly blocked from HTTP serving — unlike Info's
`config.js`, keys never reach the browser.

Open **http://127.0.0.1:8767/** — write prompt → Generate → MP4 appears in the feed.

Requires a **paid-tier** Gemini API key (Veo is not on the free tier): https://aistudio.google.com/apikey
`ffmpeg` recommended (preview thumbnails + stitching): `brew install ffmpeg`.

## What it does

```
Browser (video-generator.html)
  │  prompt + optional start image + tier/resolution/duration
  ▼  POST /api/generate            → returns jobId immediately (202)
server.py (ThreadingHTTPServer, 127.0.0.1 only)
  │  background thread → veo.py → Veo 3.1 API (submit → poll → download)
  ▼
generations/<id>/
  ├── clip.mp4        # the video (audio included)
  ├── start.png       # your uploaded frame (image-to-video runs)
  ├── frames/f01-06   # preview/QC frames (ffmpeg)
  └── meta.json       # prompt, tier, duration, cost, timings
```

Browser polls `GET /api/job/<id>` (queued → generating → downloading → done) and the finished clip lands at the top of the feed with an inline player.

## Story mode (script → clips → stitched video)

Toggle **📖 Story** in the form panel:

1. Paste your full script — scenes split automatically on lines starting with `Clip N`, `Scene N` or `---`.
2. Drop scene images (up to 10) — auto-mapped to scenes in order; adjust per scene (any scene can be "no image" = text-to-video).
3. **✨ Enhance with Haiku** (optional) — Claude Haiku reads each scene's image + script and writes the production animation prompt (style lock, camera, motion constraints, Dialogue block). Without an image it invents and pins the full visual design so shots stay consistent.
4. **Generate story** — clips generate sequentially (progress shows `clip 3/7: generating`), each lands in the feed individually, then auto-stitch produces the final MP4 as a `STORY` entry. If a scene fails, completed clips stay in the feed for manual stitch/retry.

Single-clip mode has the same **✨ Enhance** button — works with or without a dropped image.

Enhance needs an Anthropic key (server-side, like the Gemini key):
```bash
echo "sk-ant-..." > ~/.anthropic_api_key && chmod 600 ~/.anthropic_api_key
```
Cost ≈ $0.005–0.01 per scene (Haiku with image input).

## Models & cost

| Tier | Model | 720p | 1080p | 8s clip |
|---|---|---|---|---|
| **Lite** (default) | `veo-3.1-lite-generate-preview` | $0.05/s | $0.08/s | $0.40–0.64 |
| Fast | `veo-3.1-fast-generate-preview` | $0.10/s | $0.12/s | $0.80–0.96 |
| Quality | `veo-3.1-generate-preview` | $0.40/s | $0.40/s | $3.20 |

All tiers generate audio. Cost estimate shows before you click Generate; actual cost is stored in `meta.json` and totalled in the stats bar.

## Prompting tips (learned from production runs)

- **Dialogue**: add a `Dialogue:` block with `Speaker (tone): "line"` — Veo voices it. ≤4 short lines per 8s clip or speech gets rushed.
- **Image-to-video**: start prompt with "Maintain the exact art style, characters, lighting and layout of the starting frame."
- **Stop extra characters**: lite tier has no negative prompt — write constraints positively: "Exactly two children — no other children."
- **Multi-scene stories**: generate one clip per scene (one keyframe image each), then select clips in the feed → **⛓ Stitch** → single MP4. Cuts hide character drift better than one long generation.
- Voices vary per clip (audio is generated per-generation) — keep narration light or re-dub in post if voice continuity matters.

## API endpoints

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/generate` | Start a generation job → `{jobId, genId}` |
| GET | `/api/job/<jobId>` | Job status: queued / running (+detail) / done / failed |
| POST | `/api/stitch` | Concat 2–30 archived clips → new archived entry |
| GET | `/api/list` | Archive feed, newest first |
| DELETE | `/api/delete/<id>` | Remove a generation folder |
| GET | `/generations/<id>/…` | Static serving of archived files |

## Security model

- Server binds **127.0.0.1 only**; `Host` header validated (DNS-rebinding guard).
- **API key never reaches the browser.** Read server-side from `GEMINI_API_KEY` env or `~/.gemini_api_key` (chmod 600). No key in `config`, localStorage, URLs, or logs — error messages are key-redacted before display.
- All outbound traffic via the official `google-genai` SDK to Google's endpoint only.
- ids validated `^[A-Za-z0-9_\-]+$` + resolved-path containment (no traversal); model/tier/duration allow-listed.
- Upload: PNG/JPEG/WebP only, 20 MB cap, base64-validated; request bodies capped 25 MB.
- ffmpeg invoked with array args only; stitch ids re-validated server-side.
- Feed renders all archived text via `textContent` (no innerHTML with stored prompts → no stored XSS).
- `generations/` and `.venv/` git-ignored.

**Design divergence from Info/**: Info is stdlib-only with a synchronous proxy because its generations return in seconds. Veo runs 1–6 minutes, so VideoGen uses a threaded server + background jobs, and the `google-genai` SDK instead of raw urllib (LRO polling + authenticated downloads are non-trivial to hand-roll safely). One pip dependency is the deliberate trade.

## CLI (no browser)

```bash
./.venv/bin/python veo.py --prompt "A red fox runs through snowy forest at dawn" \
    --tier lite --resolution 720p --duration 8 --out out/fox
# image-to-video:
./.venv/bin/python veo.py --prompt "..." --image scene.png --out out/scene1
```

## Troubleshooting

| Problem | Fix |
|---|---|
| `API key: MISSING` on server start | Create `~/.gemini_api_key` or export `GEMINI_API_KEY` |
| 429 / quota error | Key's project has no billing — Veo needs paid tier |
| `no video returned (safety-filter…)` | Rephrase prompt; people/children content is filtered more aggressively |
| Stitch fails | `brew install ffmpeg` |
| Port 8767 in use | `lsof -ti:8767 \| xargs kill` |
