# VideoGen — AI Story & Video Generator (Veo 3.1 + Claude Haiku)

A local browser app that turns an **idea into a finished, voiced animated video**:

> idea → Haiku writes the story → storyboard per scene → pick style/voice/music → Veo 3.1 generates each clip (native audio: voices, dialogue, music) → ffmpeg stitches one movie → archived in your Library forever.

Every paid artifact — written scripts, clips, stitched movies, costs, prompts, source images — is persisted to disk. Close the terminal, restart the laptop: your Library is intact.

---

## Quick start

```bash
cd VideoGen
python3.12 -m venv .venv && ./.venv/bin/pip install google-genai   # once
cp config.example.json config.json                                  # once — add your keys
./.venv/bin/python server.py                                        # http://127.0.0.1:8767
```

| Key | Used for | Get it at | Required tier |
|---|---|---|---|
| `gemini` | Veo 3.1 video generation | aistudio.google.com/apikey | **Paid** (Veo not on free tier) |
| `anthropic` | ✍️ Story writing + ✨ prompt enhance (Claude Haiku 4.5) | console.anthropic.com | credits needed |

Key lookup order per provider: env var → `config.json` → `~/.gemini_api_key` / `~/.anthropic_api_key`.
`ffmpeg` recommended (`brew install ffmpeg`) — thumbnails + stitching.

Two UIs, same backend:
- **`/`** — VideoGen for Kids: bright tabbed flow (Script → Scenes → Style → Review → Library), 4 themes
- **`/classic`** — original dark single-page UI, flat archive list with delete

---

## How it works

```
Browser (ui/VideoGen.html — React UMD, no build step)
│
├─ ✍️  POST /api/write-story     idea + scene count → Haiku writes a Clip-N-format
│                                script → ARCHIVED as 📖 script entry → editor
├─ ✨  POST /api/enhance         per-scene script + reference image → Haiku (vision)
│                                writes production animation prompts
├─ ▶  POST /api/generate        single clip (text→video or image→video)
├─ ▶  POST /api/story           story: scenes[] + images[] → returns jobId (202)
│        │
│        ▼  background thread (ThreadingHTTPServer — UI never blocks)
│     veo.py → Veo 3.1 API: submit → poll → download   (per scene, sequential)
│        │      429 quota? retry 70s/140s/210s backoff
│        │      still limited? → stitch finished clips → status=partial
│        ▼
│     ffmpeg concat → generations/<id>/clip.mp4 + preview frames + meta.json
│
├─ ⟳  GET  /api/job/<id>        browser polls: queued → clip 3/7 generating → done
├─ ▶  POST /api/story/resume    generate ONLY pendingScenes of a partial story,
│                                re-stitch the full movie (pay only what's missing)
├─ ⛓  POST /api/stitch          concat any 2–30 archived clips into a new movie
├─ 📚 GET  /api/list            the Library = generations/ folder, newest first
└─ 🗑  DELETE /api/delete/<id>
```

### The archive is the database

```
generations/
├── 20260604-script-why-do-cats-purr/        # 📖 written story (Haiku)
│   ├── script.txt
│   └── meta.json          # idea, scene count, cost
├── 20260604-1402-bedtime-story-ab12cd/      # 🎬 story video
│   ├── clip.mp4           # stitched movie
│   ├── src01.jpg …        # reference images you uploaded
│   ├── frames/f01-06.png  # preview thumbnails
│   └── meta.json          # prompt, tier, duration, cost, sourceIds,
│                          # status (complete|partial), pendingScenes
└── 20260604-1402-bedtime-story-ab12cd-c01/  # each scene's clip, grouped
    ├── clip.mp4             under its story in the Library
    └── meta.json          # full Veo prompt used — reproducible
```

No database, no cloud. `meta.json` per entry is the full record: the exact prompt sent to Veo, model tier, resolution, duration, USD cost, creation time. Survives restarts; back it up by copying the folder.

### Models & cost (USD per generated second)

| Tier | Veo model | 720p | 1080p | 8s clip |
|---|---|---|---|---|
| Lite (default) | `veo-3.1-lite-generate-preview` | $0.05 | $0.08 | $0.40–0.64 |
| Standard | `veo-3.1-fast-generate-preview` | $0.10 | $0.12 | $0.80–0.96 |
| Pro | `veo-3.1-generate-preview` | $0.40 | $0.40 | $3.20 |

All tiers generate native audio. Clips are 4/6/8s (Veo's only lengths — UI snaps everything). Story writing ≈ $0.005–0.01 per story (Haiku). Reference build: a 60s 7-scene story at lite/720p ≈ $3 video cost.

### Rate limits handled end-to-end

Veo preview models carry small daily/minute request quotas. The pipeline:
1. 429 → automatic backoff retries (70s → 140s → 210s)
2. Still limited mid-story → completed clips are stitched into a **playable partial story**; remaining scene definitions saved as `pendingScenes`
3. Library shows ⏳ *Partial — N scenes pending* + **Generate remaining** button → resumes exactly where it stopped, same images, single re-stitch, no re-paying finished scenes

---

## Security model

Single-user local tool, but built as if the local network were hostile.

### Keys never reach the browser
- API keys live **server-side only**: env var → `config.json` → `~/.{gemini,anthropic}_api_key`. The browser never sees, stores, or transmits a key — unlike typical localStorage-key tools.
- `config.json` is git-ignored **and** explicitly blocked from HTTP serving (`GET /config.json` → 404, hardcoded guard).
- Error messages are **key-redacted** before reaching the UI (`key=…` query params and `AIza…`/`AQ.…`/`sk-ant-…` patterns stripped) — Veo download URIs embed the key, so raw errors would leak it.
- Repo hygiene: `.gitignore` covers `config.json`, `generations/`, `.venv/`; pre-push secret scans on commit.

### Network surface
- Server binds **127.0.0.1 only** — unreachable from the LAN.
- **Host-header validation**: requests must carry `Host: 127.0.0.1:8767` or `localhost:8767`, else 403. Blocks DNS-rebinding attacks (a malicious website resolving its domain to 127.0.0.1 to ride your browser into the API).
- All outbound traffic goes only to hardcoded endpoints: `generativelanguage.googleapis.com` (via the official google-genai SDK) and `api.anthropic.com` (stdlib urllib). No URL is ever derived from user input → no SSRF.

### Filesystem
- Every id parameter validated against `^[A-Za-z0-9_\-]+$` **plus** resolved-path containment (`realpath` must stay inside `generations/`) — path traversal blocked at two layers. Verified against raw `../`, URL-encoded `%2e%2e`, and mixed-encoding probes.
- Output paths are always server-constructed (timestamp-slug ids); user input never names a file.
- ffmpeg invoked with **array arguments only** — no shell string interpolation, no command injection; stitch ids re-validated server-side.

### Input handling
- Uploads: MIME allow-list (PNG/JPEG/WebP), base64-validated, 20 MB per image, request bodies capped at 60 MB. Browser additionally downscales images to ≤2048px JPEG before upload.
- Tier / resolution / duration / scene counts: strict server-side allow-lists (not trusted from the UI).
- Prompts capped (8000 chars/scene, 2000 chars/idea), scenes 1–15 (writer) / ≤20 (generation), stitch 2–30 clips.

### Output handling (XSS)
- Archived prompts/scripts are user-influenced *and* LLM-generated text. The UI renders all of it via React text nodes / `textContent` — never `innerHTML` / `dangerouslySetInnerHTML` → no stored XSS from a hostile prompt.

### What this is NOT hardened for
- Multi-user or internet exposure — there is no authentication. Do not port-forward 8767 or bind it to 0.0.0.0 without adding auth.
- The Anthropic/Gemini calls send your prompts and images to those providers — normal API terms apply.

---

## API reference

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/write-story` | `{idea, scenes:1-15}` → Haiku writes script, archives it |
| POST | `/api/enhance` | `{scenes:[{prompt,imageIndex}], images}` → animation prompts |
| POST | `/api/generate` | single clip `{prompt, tier, resolution, duration, imageBase64?}` |
| POST | `/api/story` | `{title, tier, resolution, scenes[], images[]}` → `{jobId}` |
| POST | `/api/story/resume` | `{id}` → generate pendingScenes of a partial story |
| POST | `/api/stitch` | `{ids:[2-30]}` → concat into new archived movie |
| GET | `/api/job/<jobId>` | job status: queued / running(+detail) / done / failed |
| GET | `/api/list` | archive entries (meta + thumb + image urls) |
| DELETE | `/api/delete/<id>` | remove an entry |
| GET | `/generations/<id>/…` | archived files (id-validated, path-contained) |

CLI without the browser:

```bash
./.venv/bin/python veo.py --prompt "A red fox runs through snowy forest" \
    --tier lite --resolution 720p --duration 8 --out out/fox
./.venv/bin/python veo.py --prompt "..." --image scene.png --out out/scene1   # image→video
```

## Prompting tips (learned from production runs)

- Dialogue: `Speaker (tone): "line"` under a `Dialogue:` block — Veo voices it. ≤4 short lines per 8s clip or speech rushes.
- Image-to-video: open with *"Maintain the exact art style, characters, lighting and layout of the starting frame."*
- Lite tier has no negative prompt — write constraints positively: *"Exactly two children — no other children."*
- Multi-scene: one clip per scene + cuts hides character drift far better than one long generation.
- Voices vary per clip (audio generated per-generation) — keep narration light or re-dub if voice continuity matters.

## Troubleshooting

| Problem | Fix |
|---|---|
| `API key: MISSING` on start | Add keys to `config.json` (read per-request, no restart needed) |
| 429 / `RESOURCE_EXHAUSTED` | Daily Veo quota hit — partial story saved automatically; *Generate remaining* after reset (midnight Pacific) |
| `credit balance is too low` (Haiku) | Top up at console.anthropic.com → Plans & Billing |
| `no video returned (safety-filter…)` | Rephrase — people/children content filtered more aggressively |
| Stitch fails | `brew install ffmpeg` |
| Port 8767 in use | `lsof -ti:8767 \| xargs kill` |
| UI changes not appearing | Hard refresh (⌘⇧R) — Babel-compiled JSX caches |

**Design divergence from the `Info/` sibling project**: Info is a synchronous stdlib proxy because its generations return in seconds and its keys live in the browser. Veo runs 1–6 min per clip, so VideoGen uses a threaded server + background jobs, the official `google-genai` SDK, and server-side-only keys — one pip dependency and a stronger key posture as deliberate trades.
