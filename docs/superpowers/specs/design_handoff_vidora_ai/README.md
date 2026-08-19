# Handoff: Vidora AI — Mobile Video Generation App

## Overview
A mobile-first AI video generation app. Users describe a video, pick a visual style, optionally add reference images, configure video settings (duration/aspect ratio/AI model/resolution), review, and generate. Includes Home, Projects, History, and Profile tabs.

## About the Design Files
The files in this bundle are **design references built as an HTML/React prototype** (a "Design Component" — single-file React-like component with inline styles), not production code to copy directly. Recreate these designs in the target codebase's existing environment (React Native, native iOS/Android, or web React) using its established patterns, navigation, and component libraries. If no mobile app codebase exists yet, React Native or a standard React SPA are both reasonable choices given the interaction patterns used (client-side state, no backend calls yet).

## Fidelity
**High-fidelity.** Colors, typography, spacing, and component layout are final. Copy/microcopy is final. All interactions (screen navigation, model-driven option filtering, progress simulation) are implemented and should be preserved functionally, with real API calls replacing the simulated ones.

## Screens / Views
All screens are contained in one scrollable "phone" frame (400px wide, white background, 36px corner radius, centered).

1. **Home** — Header (logo, "Vidora AI" wordmark, credit badge, avatar), hero card (headline "Create amazing videos with AI", subtitle, "+ New Video" primary button), "Recent Projects" list (thumbnail, name, meta line, 3-dot menu), bottom nav.
2. **Script** (step 1/5) — Back button, title, step counter, 4px progress bar (20% filled), large textarea (placeholder text, 2000 char cap, live counter), "Improve Prompt ✨" button (appends cinematic-lighting phrase to the prompt), tips card, sticky "Next" button. Validation: Next blocked until script is non-empty; shows "Enter a video description."
3. **Scene** (step 2/5) — Progress bar 40%. 2-column grid of style cards (Cinematic, 3D Animation, Anime, Photorealistic, Cartoon, Watercolor, Fantasy, Custom), each with a gradient thumbnail, small icon badge (top-left), name, and a selected-state check badge (top-right) when active. Only 6 shown by default; "+ See all styles" / "− Show fewer styles" toggle reveals the remaining 2. Validation: Next blocked until one style is selected.
4. **References** (step 3/5) — Progress bar 60%. "Supported by {model}" chip legend (Character / Scene / Object / Start Frame / End Frame — struck-through and greyed when unsupported by the current model). 2-column grid of 5 image-upload tiles, each with a tappable label chip that cycles through the model's supported reference types. If the selected model doesn't support references at all, tiles are greyed out and disabled, with an inline warning banner. "References are optional" note. Next always enabled.
5. **Video Settings** (step 4/5) — Progress bar 80%. AI Model picker (custom dropdown row, opens a list of models with per-model credit cost); "Estimated cost: N credits" line. Duration chips, Aspect Ratio cards (3-col grid with a mini rectangle icon per ratio), Resolution picker (same dropdown pattern) — **all three are filtered to only the options the selected model supports** (this is the core capability-driven behavior — see Model Config below). Collapsible "Advanced Settings": Camera Movement chips, Motion Intensity chips, Prompt Adherence slider, Seed text field, Negative Prompt textarea, and an Audio Generation toggle (only shown if the model supports audio). Sticky "Review Video" button.
6. **Review** (step 5/5) — Progress bar 100%. Large video-preview placeholder (aspect ratio matches the chosen aspect ratio) with a centered play button overlay. Summary rows (Script excerpt, Scene Style, Reference Images count, Duration, Aspect Ratio, AI Model, Resolution) each with an "Edit" link that jumps back to the relevant step. "Estimated cost: N credits" pill. Primary CTA "Generate Video ✨" (gradient-highlighted, the strongest visual button in the flow).
7. **Generating** — No back/bottom nav. Large circular progress ring (conic-gradient) with live percentage in the center. 5-stage checklist (Preparing prompt → Processing reference images → Generating video → Processing output → Finalizing) with check/active/pending states driven by progress thresholds. "Run in Background" button returns to Home while the job "continues" (simulated).
8. **Result** — Header "Your Video is Ready 🎉". Video player placeholder with play overlay and a fake scrubber (00:00 → duration). 2×2 meta grid (Duration, Model, Resolution, Aspect Ratio). 4-icon action row (Download, Share, Regenerate, Edit Prompt). Primary "Create Another Video" (resets the wizard), secondary "View Project".
9. **Projects** — Title, 4-way filter tabs (All/Generating/Completed/Failed) that filter the list client-side, project list with status badges (Completed = green, Generating = amber, Failed = red), "+ New Video" button.
10. **History** — List of past generation jobs with status-driven action buttons (Retry for Failed, Cancel for Queued, View for Completed).
11. **Profile** — Avatar, name/email, credit balance banner with "Top up" button, settings row list (Account Details, Credits & Billing, Notifications, Help & Support).

**Bottom navigation** (Home | Projects | + | History | Profile, center "+" visually raised/prominent) appears on Home/Projects/History/Profile only — hidden throughout the Script→Review→Generating→Result wizard flow.

## Interactions & Behavior
- **Screen navigation** is a simple state machine (`screen` string) — no URL routing in the prototype; implement real navigation (stack/tab navigator) in the target app.
- **Model-driven capability filtering** (the key architectural pattern — see Model Config): changing the AI Model immediately re-filters Duration, Aspect Ratio, Resolution, Audio toggle visibility, and Reference-type options to only what that model supports; if the current selection becomes invalid, it snaps to the model's first supported value.
- **Validation**: inline, non-modal. Script screen blocks "Next" with a message if empty; Scene screen blocks "Next" if no style selected. References and Settings have no hard blockers (references are optional; settings always have a valid default).
- **Generating progress**: simulated with a timer incrementing ~7%/300ms; in production this should poll/subscribe to the real job status instead.
- **Reference image label cycling**: tapping a tile's label chip cycles through that model's supported reference types (Character/Scene/Object/Start Frame/End Frame).
- Style "See all" toggle expands the scene-style grid from 6 to 8 cards in place (no navigation).

## State Management
Suggested state shape (mirrors the prototype's local state):
```
screen: enum
script: string
sceneStyle: string | null
refLabels: { [slotIndex]: refTypeKey }
duration: number
aspectRatio: string
modelId: string
resolution: string
advancedOpen: boolean
camera, motion: string
promptAdherence: number (0-100)
seed: string
negativePrompt: string
audio: boolean
generatingProgress: number
projectTab: string
```
Data fetching needed in production: recent/all projects list, generation history, job status/progress (websocket or polling), model config list (see below), credit balance, uploaded reference image storage.

## Model Config (capability-driven — do not hard-code)
This is the most important architectural requirement: models must come from a configurable list, not be hard-coded into the UI. Each model record needs:
```
{ id, name, durations: number[], aspectRatios: string[], resolutions: string[],
  refSupport: boolean, refTypes: ('character'|'scene'|'object'|'start_frame'|'end_frame')[],
  audio: boolean, cost: number }
```
Prototype's example models: Seedance, Kling 1.6 Pro, Veo 3, Runway Gen-4, Hailuo 2.0 (see the DC's `MODELS` array for exact capability values used). Adding a new provider/model should require zero UI code changes — only a new config entry.

## Design Tokens
- **Primary accent (blue, "professional" direction)**: `#2F5FCF`; hover/darker: `#20408F`; gradient light stop: `#4E7CDB`; light tint bg: `#EAF0FB`; avatar tint bg: `#DCE6F8`
- **Background**: `#FFFFFF`; secondary/card background: `#F7F7F8`
- **Primary text**: `#111111`; secondary text: `#6B6B73`
- **Borders**: `#E8E8EC`
- **Status colors**: success/completed bg `#E9F7EF` text `#1E8E4A`; warning/generating bg `#FFF6E9` text `#8A6415`; error/failed bg `#FDECEC` text `#C6362C`
- **Radii**: cards 14–20px, buttons 14px, chips/badges 999px (pill), inputs 12–14px
- **Primary buttons**: 52–56px height
- **Typography**: system sans-serif stack (-apple-system, Segoe UI, Roboto); weights 500–800; body ~13–15px, headings 18–22px, hero 22px

## Assets
- `assets/app-logo.png` — Vidora AI app icon/logomark (user-supplied), used at 30×30px in the Home header.
- All thumbnails/previews/reference uploads are drag-and-drop image placeholders in the prototype (no real media) — wire these to real upload/storage and generated-video URLs in production.

## Files
- `AI Video Generator.dc.html` — the full design/prototype (all 11 screens, all interactions described above).
