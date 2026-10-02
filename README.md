# SparkGarden — AI Story & Video Generator (Veo 3.1 · Grok Imagine · Seedance 1.5 + Claude Haiku)

A local browser app that turns an **idea into a finished, voiced animated video**:

> idea → Haiku writes the story → storyboard per scene → pick style/voice/music → Veo 3.1 generates each clip (native audio: voices, dialogue, music) → ffmpeg stitches one movie → archived in your Library forever.

Every paid artifact — written scripts, clips, stitched movies, costs, prompts, source images — is persisted to disk. Close the terminal, restart the laptop: your Library is intact.

---

## Quick start

```bash
cd VideoGen
python3.12 -m venv .venv && ./.venv/bin/pip install google-genai   # once
cp config.example.json config.json                                  # once — add your keys
./.venv/bin/python3 server.py                                       # http://127.0.0.1:8767
```

Every time after: `cd VideoGen && ./.venv/bin/python3 server.py`.
**Must use `.venv/bin/python3`** — plain `python3` on macOS resolves to the system 3.9, which crashes on `veo.py`'s `Path | None` syntax (needs 3.10+).

| Key | Used for | Get it at | Required tier |
|---|---|---|---|
| `gemini` | Veo 3.1 video generation | aistudio.google.com/apikey | **Paid** (Veo not on free tier) |
| `anthropic` | ✍️ Story writing + ✨ prompt enhance (Claude Haiku 4.5) | console.anthropic.com | credits needed |
| `openrouter` | Grok Imagine Video (xAI) + Seedance 1.5/2.0 Pro/Fast/Mini (ByteDance) | openrouter.ai/keys | credits needed (optional) |
Key lookup order per provider: env var → `config.json` → `~/.{gemini,anthropic,openrouter}`.
Each engine needs only its own key — Veo works without an OpenRouter key and vice versa.
`ffmpeg` recommended (`brew install ffmpeg`) — thumbnails + stitching.

Two UIs, same backend:
- **`/`** — SparkGarden (chat, pictures and videos): bright tabbed flow (Script → Scenes → Style → Review → Library), 4 themes
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
│     engine dispatch (tier → provider):
│       veo.py              → Veo 3.1 (Gemini API): submit → poll → download
│       openrouter_video.py → Grok Imagine / Seedance 1.5 Pro (OpenRouter
│                             /api/v1/videos): submit → poll → download
│        │      429 quota? retry 70s/140s/210s backoff (both providers)
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

| Tier / model | Engine | 720p | 1080p | 8s clip |
|---|---|---|---|---|
| Lite (default) | `veo-3.1-lite-generate-preview` | $0.05 | $0.08 | $0.40–0.64 |
| Standard | `veo-3.1-fast-generate-preview` | $0.10 | $0.12 | $0.80–0.96 |
| Pro | `veo-3.1-generate-preview` | $0.40 | $0.40 | $3.20 |
| Grok Imagine | `x-ai/grok-imagine-video` (OpenRouter) | ~$0.07 | — (720p max) | ~$0.56 |
| Seedance 1.5 | `bytedance/seedance-1-5-pro` (OpenRouter) | ~$0.052 | ~$0.117 | $0.42–0.94 |
| Seedance 2.0 Fast | `bytedance/seedance-2.0-fast` (OpenRouter) | ~$0.040 | ~$0.040 | ~$0.32 (unverified live) |
| Seedance 2.0 Mini | `bytedance/seedance-2.0-mini` (OpenRouter) | ~$0.013 | — (720p max) | ~$0.20 (promo pricing, real rate observed ~2×) |

OpenRouter engines are billed by OpenRouter; the archived cost uses the API's reported `usage.cost` when available, falling back to the per-second estimate. OpenRouter rates above are **observed billed rates** (2026-06-04 test runs incl. audio) — the listing's bare per-second price bills lower than reality. All models generate native audio.

**Format**: 16:9 landscape (default) or 9:16 portrait for Shorts/Reels/TikTok — selectable per run in both UIs. Constraint: 9:16 on Veo is 720p only (server-enforced); Grok is 720p max everywhere; Seedance does 9:16 up to 1080p.

**Character reference** (Script tab): drop a character sheet or up to 3 reference images — characters keep that exact look in every scene without the reference appearing on screen. Veo uses `reference_images` (ASSET "ingredients"); Grok/Seedance use OpenRouter `input_references`. A scene with its own starting image uses that frame instead (the two modes are mutually exclusive per clip). Clip length: Veo is locked to 4/6/8s (hard API limit); Seedance 1.5/2.0 Fast do 4–12s, Seedance 2.0 Mini does 4–15s — the Scenes-tab stepper offers the full union since the engine isn't picked until the Style tab (server rejects a mismatched pick at generate time with a clear error). Story writing ≈ $0.005–0.01 per story (Haiku). Reference build: a 60s 7-scene story at lite/720p ≈ $3 video cost.

### Rate limits handled end-to-end

Veo preview models carry small daily/minute request quotas. The pipeline:
1. 429 → automatic backoff retries (70s → 140s → 210s)
2. Still limited mid-story → completed clips are stitched into a **playable partial story**; remaining scene definitions saved as `pendingScenes`
3. Library shows ⏳ *Partial — N scenes pending* + **Generate remaining** button → resumes exactly where it stopped, same images, single re-stitch, no re-paying finished scenes

---

## Security model

Single-user local tool, but built as if the local network were hostile.

### Chat, Pictures and Library (ChatGPT-style shell)
- **Layout:** left menu = Chat · Pictures · Videos · My Library (+ *Users & credits* for admins). Chat and Pictures keep a *Recent* list in this browser (per user); pictures and videos themselves live on the server, so **My Library** shows them on any device (filters, viewer, save, two-step delete).
- **Chat** (kid-safe "Sunny"): `deepseek/deepseek-v4-flash` (default) or `minimax/minimax-m3` (can look at attached pictures) through OpenRouter. Replies are scanned before display. **Pictures**: `bytedance-seed/seedream-5-0-flash` (~$0.018/picture, can use an attached drawing) or `inclusionai/ming-image-0.1-design` (free, words only). Both bill against the user's credits and honour the engine allow-list.
- **Attached pictures** (button, drag-drop or paste; **must be < 2 MB**, PNG/JPEG/WebP): re-encoded to a clean JPEG (EXIF/GPS stripped, max 1536 px), checked by Claude Haiku vision (also reads text in the image) **before** anything else sees it, fail-closed, 30 checks/user/hour. Drawings used as a reference are kept next to their result (same owner only).
- **Voice typing:** mic button fills the message box (Web Speech API — free; audio is processed by the browser vendor's speech service, the resulting text still goes through the normal safety check). Browsers only allow the microphone on `https://` or `localhost`: run with `VIDEOGEN_TLS_CERT=… VIDEOGEN_TLS_KEY=… VIDEOGEN_COOKIE_SECURE=1` (e.g. a Tailscale `tailscale cert` certificate).
- **Examples** (left menu, every signed-in user, read-only): curated videos shown with the pictures that went in, the full prompt and the result, plus a **Try this prompt in Videos** button. They live in the repo under `examples/<slug>/` (`example.json`, `clip.mp4`, `poster.jpg`, `asset*.jpg`), so they are reviewed before shipping and are **not** affected by the 48-hour video clean-up or by disk loss. Add one from a video you have **already generated** (no regeneration, no API cost): `./.venv/bin/python3 tools/bundle_example.py <generation-id> --title "My example" [--summary "…"] [--shrink] [--force]`, then review `poster.jpg`, the pictures and the prompts in `example.json` (everyone will see them; the tool also refuses text the safety word list flags and strips cost/owner/dates), commit, push and redeploy. Videos over 30 MB need `--shrink` (720p re-encode).
- **Content safety:** every text input (all modes) and every attached picture is checked before any spend — local normalising word filter (leetspeak/spacing/look-alike letters) + Claude Haiku classifier, fail-closed. Blocks are logged for review in *Users & credits*; 3 strikes in 24 h suspend an account, sexual content involving minors suspends at once, self-harm gets a supportive message and no strike. Generated images/videos are not scanned after creation.

### Accounts, 2FA and per-user isolation
- Sign-in is always on: **username + password + 6-digit authenticator (TOTP) code**. Accounts live in `users.db` (git-ignored, mode 0600); passwords are salted scrypt hashes. The old shared `keys.password` / `session_secret` are no longer read — delete them from `config.json`.
- **First run:** the server prints a one-time admin setup link (`ADMIN SETUP …`) to the console / `server.log`. Open it, scan the QR code, choose a password and confirm with a code. Lost the device? Start once with `VIDEOGEN_RESET_ADMIN=1` to issue a new admin link.
- **Admin page** (`/admin`, admins only): add users, disable/enable, and *Reset 2FA + password* (revokes their sessions and issues a new one-time setup link, valid 24 h, shown once). Users enroll themselves, so you never see their passwords.
- **Isolation:** each generation is owned by its creator (`gen_owner` table). Users list/view/delete/stitch/resume and poll jobs only for their own; others return 404. Admins see everything; pre-existing folders have no owner and are admin-only.
- Sessions are random server-side ids (7-day expiry, `HttpOnly`, `SameSite=Strict`; set `VIDEOGEN_COOKIE_SECURE=1` once served over HTTPS). A password-only login yields no session. A TOTP code works once; 5 wrong codes force a re-login; per-IP (10/5 min) and per-user (5/15 min) rate limits apply.
- **Credits:** each non-admin user has a USD balance, an optional daily spend cap and an engine allow-list, all set in `/admin` (*Credits & limits* under each user). A submit reserves the job's estimated cost atomically (HTTP 402 if the balance or daily cap doesn't cover it, 403 for a disallowed engine); when the job ends it is settled once — failed jobs refund in full, finished jobs refund `estimate − actual cost`. Admins are unmetered. Every movement is recorded in the `credit_ledger` table. Credits follow the app's own cost estimates, not the provider's invoice (OpenRouter has billed ~2× its listing rate). `/api/me` returns the signed-in user's balance; the header shows it.
- Not metered yet: ✨ Enhance, ✍️ Write story and the storyboard vision read call (small Anthropic costs) — only a zero-balance user is stopped from starting a storyboard.
- Admin forms carry a per-session CSRF token. Static files are default-deny — only `/ui/*`, `/video-generator.html` and owned `/generations/*` are served.
- Still plain HTTP: put it behind HTTPS/Tailscale before exposing it beyond your machine. Remote access is opt-in: `VIDEOGEN_BIND=0.0.0.0 VIDEOGEN_PUBLIC_HOST=<ip-or-domain>`.
- Tests: `./.venv/bin/python3 -m unittest discover -s tests -v`.

### What this is NOT hardened for
- Direct internet exposure over plain HTTP — accounts + 2FA exist, but there is no TLS and no per-user spend quota. Use HTTPS/Tailscale first.
- The Anthropic/Gemini calls send your prompts and images to those providers — normal API terms apply.

## Deploying to Render (staging)

> **Approvals first.** This puts kids' accounts, drawings and chats on a public server: get your tech lead's sign-off and tell compliance (hosting region, retention, backups) *before* creating anything. Use a **staging** service first; production changes need human approval outside the codebase.

What was prepared in the repo: `Dockerfile` (Python 3.12 + ffmpeg, runs as non-root), `deploy/entrypoint.sh` (fixes disk ownership), `requirements.txt` (pinned), `.dockerignore` (keeps `config.json`, `users.db`, `generations/` out of images), `render.yaml` (Blueprint, staging) and in the app: `PORT`, `VIDEOGEN_DATA_DIR`, bare-domain host names, `VIDEOGEN_TRUST_PROXY` / `VIDEOGEN_PROXY_HOPS`, `GET /healthz`.

1. In Render choose **New → Web Service**, connect **only this repository**, pick the **`deploy/render-staging`** branch (not `main`), language **Docker**, a **paid** plan, **1 instance**, health check path `/healthz`, auto-deploy **off**. (Or create it from `render.yaml`.)
2. Add a **persistent disk** mounted at `/var/data` (≥ 10 GB). Only that path survives deploys; it holds `users.db` and `generations/`.
3. Environment variables (secrets go in Render, never in git): `VIDEOGEN_DATA_DIR=/var/data`, `VIDEOGEN_BIND=0.0.0.0`, `VIDEOGEN_COOKIE_SECURE=1`, `VIDEOGEN_TRUST_PROXY=1`, `VIDEOGEN_PUBLIC_HOST=<your-service>.onrender.com`, plus `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`, `ARK_API_KEY`.
4. First deploy: open the service **Logs** and find the `ADMIN SETUP (one-time link, 24 h)` line — it is a credential, so use it once and treat the log as sensitive. Then create users in *Users & credits*.
5. **Video retention:** `VIDEOGEN_VIDEO_RETENTION_HOURS=48` (set in the Docker image and `render.yaml`) deletes **videos** — clips, stories, stitched movies and their frames/uploads — 48 h after they are made, checked every 30 min. **Pictures and saved scripts are kept.** Running generations are never touched, and nothing is deleted unless this variable is set (unset/0 = keep everything, the default for local use). Both Libraries show "Expires in N h" on each video plus a reminder to press Save. On start the log says how many existing videos are already past the limit. Usage/profit history is kept.
6. Operations: a redeploy stops the service for a few seconds and **kills running video jobs** (deploy when idle). Render takes daily disk snapshots (≥ 7 days) but add your own backup of `/var/data`; a restore loses everything newer than the snapshot. Keep exactly one instance (SQLite + in-memory jobs).
7. Not verified here: the Docker image build itself (no Docker on the dev machine), Render's request timeout / upload-size limits (the app accepts uploads up to ~60 MB and requests that run for minutes) and the exact Blueprint keys — check them on the first staging deploy.

---

## API reference

| Method | Path | Purpose |
|---|---|---|
| GET/POST | `/login`, `/login/2fa` | username+password, then authenticator code → session cookie |
| GET/POST | `/enroll/<token>` | one-time account setup (QR + password), no session needed |
| GET/POST | `/admin`, `/admin/users[/<id>/disable\|enable\|reset]` | user management (admin + CSRF token) |
| POST | `/logout` | clears the session cookie, redirects to `/login` |
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
| UI changes not appearing | Hard refresh (⌘⇧R) first; if the browser still serves stale JS, bump the `?v=N` query on the `<script>` tags in `ui/VideoGen.html` |
| `python3 server.py` crashes on `Path \| None` | Wrong interpreter — use `./.venv/bin/python3 server.py`, not the system `python3` (see Quick start) |

**Design divergence from the `Info/` sibling project**: Info is a synchronous stdlib proxy because its generations return in seconds and its keys live in the browser. Veo runs 1–6 min per clip, so VideoGen uses a threaded server + background jobs, the official `google-genai` SDK, and server-side-only keys — one pip dependency and a stronger key posture as deliberate trades.
