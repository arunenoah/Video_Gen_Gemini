# VideoGen Laravel API Backend — Design Spec

**Date:** 2026-08-19 (updated same day — added UI reference + web frontend)
**Status:** Approved (backend sub-project). Mobile app (React Native/Expo) is a separate sub-project, specced after this API is built and testable. Current Python app stays live at `http://localhost:8767/` untouched during this migration; Laravel local dev uses its own port (artisan default `:8000`), no clash.
**Source:** Port of `/Users/arunkumar/Documents/Application/VideoGen` (Python `http.server` app) to Laravel, for team stack standardization and Forge deployment.
**UI reference:** "Vidora AI" design handoff (`design_handoff_vidora_ai/AI Video Generator.dc.html`, provided 2026-08-19) — high-fidelity 11-screen design (Home/Script/Scene/References/Settings/Review/Generating/Result/Projects/History/Profile). Adopted as the target UI for **both** the Blade web frontend and the future React Native app, adapted per decisions below.

## Context

Current app: a single-process Python `http.server` bound to `127.0.0.1`, filesystem-as-database (each generation is a folder with `meta.json` + media files), one shared password for auth, in-memory thread dict for background job status, keys in `config.json`/env. It calls four AI providers (Gemini/Veo, Anthropic Claude, OpenRouter, ARK/Seedance) to generate video clips and multi-scene "stories," then stitches/subtitles with `ffmpeg`.

Goal: rebuild as a Laravel backend so the team's stack is standardized on Laravel and deployment goes through the existing Forge server, serving **two** frontends off one API: a Blade/Livewire web app and a future React Native app (iOS + Android, one codebase). This spec covers the **backend + Blade web frontend**; the React Native app is specced separately once this is built and testable.

## Decisions (from brainstorming)

| Decision | Choice | Why |
|---|---|---|
| Data storage | DB tables (MySQL) + S3 for files | Laravel-idiomatic, Forge-friendly, matches other projects in the workspace |
| Auth | Per-user accounts (Sanctum) | Standard Laravel auth, fits multi-device/mobile use |
| API keys | Per-user, encrypted | Each user supplies own provider keys, billed separately |
| Data visibility | Private per-user | Each user sees only their own generations |
| Frontend (future) | React Native / Expo | One codebase → iOS + Android app stores |
| Project location | New Laravel project, fresh `laravel new` | New folder alongside VideoGen |
| Sequencing | Backend first, mobile app specced separately once API is real | Avoids designing the app against a backend that might still shift |
| UI target | Adopt "Vidora AI" design fully, for both web and app | High-fidelity, capability-driven model UI — reuse instead of re-designing |
| Billing model | Keep per-user API keys — **no credits system** | Design's credit-balance/top-up model conflicts with earlier bring-your-own-key decision; dropped in favor of the earlier decision |
| Web access | Add Blade + Livewire frontend to the same Laravel backend | "Everything on Laravel" — avoids a second JS SPA framework for web; RN app covers native mobile separately |

## Architecture

Laravel backend serving two frontends:
- **API** (`/api/v1/*`) — Sanctum bearer-token auth, consumed by the future React Native app.
- **Web** (Blade + Livewire) — session (web guard) auth, consumed by browsers.

Both sit on the same underlying service/action classes (`App\Actions\*`, `App\Services\*`) — no business logic duplicated between the two; controllers on each side are thin. MySQL for relational data. S3 for video/frame files. Redis-backed queue for background generation jobs. Deployed on the existing Forge server as a new site.

## Data Model

- **users** — Laravel default + Sanctum `HasApiTokens`.
- **api_keys** — `id`, `user_id`, `provider` enum(`gemini`,`anthropic`,`openrouter`,`ark`), `key` (Eloquent `encrypted` cast), timestamps. Unique on (`user_id`, `provider`).
- **generations** — `id`, `user_id`, `kind` (`clip`|`story`), `status`, `prompt`, `tier`, `resolution`, `aspect`, `duration`, `cost`, `clip_path` (S3 key), `source_ids` (JSON), `pending_scenes` (JSON), timestamps. Replaces `meta.json`.
- **generation_jobs** — `id` (uuid), `user_id`, `generation_id` nullable FK, `type`, `status` (`queued`|`running`|`done`|`failed`), `detail`, `progress`, `error`, timestamps. Named to avoid colliding with Laravel's own `jobs` queue table. Polled by the client.

All models use explicit `$fillable` allow-lists (no `$guarded = []`).

## Auth & API Keys

Sanctum personal access tokens (bearer, not SPA cookie mode). Login rate-limited via `throttle` middleware, replicating the current Python lockout behavior. Logout revokes the current token (`currentAccessToken()->delete()`).

Per-user API keys (`api_keys` table) stored via Eloquent `encrypted` cast. Managed via `/api/v1/keys` — write-only: the API never returns a stored key in full, only a masked form (e.g. last 4 characters) via a model accessor.

## Provider Integrations

One service class per provider behind a shared `VideoEngineInterface`:
- `GeminiVeoService`
- `AnthropicService`
- `OpenRouterService`
- `ArkService`

Each uses Laravel's `Http::` client with the authenticated user's own stored (decrypted) key, resolved via a repository — never a key passed from the client request. Engine → provider/resolution mapping lives in `config/engines.php`, mirroring the current `ENGINES` map:

```
lite/fast/quality        -> veo        (720p/1080p)
grok                      -> openrouter (480p/720p)
seedance/seedance-fast    -> openrouter (720p/1080p)
seedance-mini/seedance-2.5 -> openrouter (480p/720p)
ark-seedance-mini         -> ark        (480p/720p)
```

Provider base URLs are hardcoded in config — never built from user input (SSRF control).

`GET /api/v1/models` exposes this same `config/engines.php` map to both frontends, shaped to match the design's capability-driven `MODELS` record so the UI's model-driven filtering (duration/aspect/resolution/audio/ref-type options all re-filter on model change) works unmodified against real data:

```
{ id, name, durations: number[], aspectRatios: string[], resolutions: string[],
  refSupport: boolean, refTypes: (...)[], audio: boolean, costEstimateUsd: float }
```

`costEstimateUsd` reuses the existing `engine_estimate(tier, resolution, duration)` logic from the Python app — a real USD estimate, not a credit count. Adding a new provider/model is a `config/engines.php` entry only, zero UI changes, matching the design's "do not hard-code models" requirement.

## Background Jobs

`ShouldQueue` job classes replace `threading.Thread`:
- `GenerateClipJob`
- `GenerateStoryJob`
- `StitchJob`
- `EnhanceJob`

Queue driver: Redis (Forge-supported). Each job updates its `generation_jobs` row via an atomic `DB::transaction()` + `lockForUpdate()` (or a single atomic `->update()`) to avoid races between concurrent workers. Client polls `GET /api/v1/jobs/{id}`, scoped to the authenticated user.

## Files & ffmpeg

- Scratch work happens in `storage_path("app/tmp/{job_uuid}")` — path built only from a server-generated UUID, never from user input.
- ffmpeg invoked via `Symfony\Component\Process\Process` with array args only — never a shell string (matches the current Python app's `# ffmpeg invoked with array args only` discipline).
- Final artifacts pushed to S3 under `"{user_id}/{generation_id}/{uuid}.ext"` keys, generated server-side.
- Client gets temporary signed S3 URLs for playback/download.
- Scratch dir swept by a scheduled `app:cleanup-tmp` command (Forge scheduler).

## Input Validation

Every endpoint has a dedicated `FormRequest` with explicit `rules()`:
- `prompt`: string, required, max 8000 chars.
- `tier`/`resolution`/`aspect`: `in:` rules against the `config/engines.php` allow-list — server-side validated combination, not trusted from the client.
- `duration`: integer, validated against the tier's allowed range.
- `imageBase64`/`imageMime`: MIME must be in a closed allow-list; after base64 decode, bytes are re-verified via `finfo` (not trusted from the client-declared MIME); size capped at 20MB both pre- and post-decode.
- `scenes[]`/`referenceImages[]`: capped array length, same per-scene prompt/duration validation as above.

## API Surface (`/api/v1`, Sanctum-protected except `auth/*`)

```
POST   /api/v1/auth/register
POST   /api/v1/auth/login
POST   /api/v1/auth/logout

GET    /api/v1/keys
PUT    /api/v1/keys/{provider}
DELETE /api/v1/keys/{provider}

GET    /api/v1/models

GET    /api/v1/generations          # ?status=&kind= — backs both Projects and History screens
POST   /api/v1/generations
DELETE /api/v1/generations/{id}

POST   /api/v1/stories
POST   /api/v1/stories/resume
POST   /api/v1/write-story
POST   /api/v1/restructure
POST   /api/v1/storyboard
POST   /api/v1/enhance
POST   /api/v1/stitch

GET    /api/v1/jobs/{id}
```

Every record-scoped endpoint (`generations/{id}`, `jobs/{id}`, `keys/*`) resolves via route-model binding scoped to `auth()->id()` or an explicit Policy — never a bare `Model::find()` returned across users (IDOR control).

## Web Frontend (Blade + Livewire)

Mirrors the "Vidora AI" design's screens as Livewire components under a session-authenticated (`web` guard) route group — separate from `/api/v1` but backed by the same `App\Actions`/`App\Services` layer, so validation and security controls below apply identically to both frontends:

- **Layout**: single Blade layout (`resources/views/layouts/app.blade.php`) hosting the bottom-nav shell (Home/Projects/History/Profile), hidden during the wizard per the design.
- **Wizard** (`Script → Scene → References → Settings → Review`): one Livewire component per step, sharing state via a parent `GenerationWizard` component (mirrors the design's single `screen`/state-machine model) — no page reload between steps, matches the design's SPA-like feel without a separate JS framework.
- **Generating/Result**: Livewire polling (`wire:poll`) against `generation_jobs` status, replacing the design's simulated progress timer with the real job's `progress` column.
- **Adaptations from the design**: no credit badge/top-up screens (dropped per billing decision above); "Estimated cost" shown in USD; model list sourced from `/api/v1/models`' underlying service, not the design's placeholder `MODELS` array.
- **Auth**: standard Laravel session auth (Breeze-scaffolded login/register), independent of the RN app's Sanctum tokens but same `users` table.
- **Assets**: `assets/app-logo.png` from the design handoff copied to `public/img/app-logo.png`; design tokens (colors, radii, spacing from the handoff's README) become Tailwind config / CSS variables, not re-derived.

CSRF protection applies normally to this route group (Blade forms/Livewire actions are stateful, unlike the stateless API) — the one control this adds beyond the API surface's threat model.

## Security Controls (binding — from pass-1 threat model)

These are non-negotiable implementation requirements, not judgment calls:

1. **IDOR**: every `generations`/`generation_jobs`/`api_keys` lookup scoped to `auth()->id()` (query scope or Policy).
2. **Function-level authz**: all `/api/v1/*` routes except `auth/*` behind `auth:sanctum` middleware.
3. **Mass assignment**: explicit `$fillable` on every model; controllers build from `FormRequest::validated()`, never `$request->all()`.
4. **Input validation**: dedicated `FormRequest` per endpoint — no inline `$request->input()` trust.
5. **Secrets at rest**: `'key' => 'encrypted'` cast on `ApiKey`; API only ever exposes a masked accessor.
6. **Secrets in config**: `config('services.*')` only; never `env()` outside `config/*.php`; `.env` not committed.
7. **Shell safety**: `Symfony\Process` array-arg form only for ffmpeg — never a shell string.
8. **SSRF**: provider base URLs hardcoded in config; no service accepts a URL from the request.
9. **Path safety**: all S3 keys and scratch paths server-generated (UUID-based); never derived from client-supplied filenames.
10. **Upload validation**: MIME sniffed from decoded bytes (`finfo`), not trusted from the client-declared MIME; size capped pre- and post-decode.
11. **Rate limiting**: `throttle` on `auth/login` and on generation-creating endpoints (cost-bearing external calls, key-draining abuse prevention).
12. **Job state races**: atomic updates (`lockForUpdate()` or single atomic `->update()`) on `generation_jobs` status transitions.
13. **Logging hygiene**: no raw API keys, tokens, or full prompt bodies logged verbatim to error trackers.
14. **Dependency hygiene**: `composer audit` run in CI before deploy.
15. **CSRF (web frontend only)**: Blade/Livewire route group keeps Laravel's default CSRF middleware active (session-based, stateful) — the API route group stays token-based/stateless and does not need it.

## Deployment (Forge)

- New Forge site (PHP-FPM + Nginx) on the existing server.
- `php artisan queue:work` as a Forge daemon (supervisor-managed).
- ffmpeg installed via a Forge server recipe.
- AWS/S3 credentials set as Forge environment variables (never committed).
- Scheduler entry (`app:cleanup-tmp`) registered in Forge's scheduler.

## Testing

Pest feature tests per endpoint. `Http::fake()` to mock all four provider integrations (no live API calls in CI). Negative-path tests for each MUST-VERIFY security control above (unauthorized cross-user access, oversized upload, invalid MIME, malformed engine/tier combo, rate-limit trip). Livewire components covered by Pest's Livewire testing helpers (`Livewire::test(...)`), same negative-path coverage as the API for the shared Action/Service layer.

## Out of Scope (this spec)

- React Native mobile app — separate spec, after this API exists and is testable. Will reuse the same "Vidora AI" design reference and the same `/api/v1` endpoints (including `/api/v1/models`) built here.
- Migrating existing `generations/` folder data from the Python app into the new DB/S3 — a one-off migration script, to be scoped separately if needed.
- Credits/billing system — explicitly dropped; revisit only if the per-user-API-key model changes later.
