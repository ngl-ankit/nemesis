# NEMESIS — Voice-Based AI Debate Opponent

> *Argue. Get dismantled. Improve.*

Nemesis is a voice-first debate sparring partner. You state an opinion; Nemesis (an
Ultron-flavoured adversary powered by Groq-hosted Llama models) fires back a counter-argument,
scans your reasoning for logical fallacies in real time, rates the strength of each point, and
issues a full scorecard at the end. Everything runs inside a holographic HUD — a live Three.js
reactor core that breathes with the conversation.

**Stack:** Python 3.12 · Flask 3 · Gunicorn · Groq (OpenAI-compatible SDK) · SQLite / Postgres ·
vanilla JS (ES modules) · Three.js · Web Speech API · PWA.

---

## Contents

1. [Features](#features)
2. [Local setup](#local-setup)
3. [Environment variables](#environment-variables)
4. [Deploying to Render](#deploying-to-render)
5. [Storage decision — Postgres vs Persistent Disk](#storage-decision)
6. [API reference](#api-reference)
7. [Design system](#design-system)
8. [Testing & verification](#testing--verification)
9. [Project structure](#project-structure)
10. [Troubleshooting](#troubleshooting)

---

## Features

### Debate engine
| | |
|---|---|
| **Voice in / voice out** | Web Speech API recognition with interim results; SpeechSynthesis playback, sentence-queued so speech starts before the model finishes. |
| **Text input fallback** | Type when you can't talk. Same pipeline, same scoring. Keyboard shortcut `T`. |
| **Streaming responses** | `/api/debate/stream` is Server-Sent Events — tokens land in the transcript as they're generated. |
| **Four personas** | Ultron · Economist · Ethicist · Skeptic, each with its own system prompt and TTS voice profile. |
| **Difficulty levels** | Novice / Adept / Ultron — control steelmanning depth, concession rate and verbosity. |
| **Aggression slider** | 0–100 tone dial, injected into the system prompt. |
| **Topic starter deck** | 25 curated prompts across 5 categories (`nemesis/topics.json`). |
| **Round timer** | Optional per-turn countdown ring around the core (30 s – 3 min). |
| **Custom wake phrase** | Default *"Wake up, Ultron"*; change it in System Config. Always-listen mode optional. |
| **Multi-language** | English, Spanish, French, German, Italian, Portuguese, Hindi, Japanese, Chinese — Nemesis responds in kind. |

### Analysis
| | |
|---|---|
| **Live fallacy scan** | Each point is checked for ad hominem, strawman, slippery slope, false dilemma, etc. Detection triggers a red glitch on the transcript bubble and a HUD callout tethered to the core. |
| **Argument-strength meter** | 0–100 gauge per point, with justification. |
| **Rhetoric integrity** | Rolling you-vs-Nemesis integrity bar (mean strength minus fallacy penalties). |
| **Scorecard HUD** | Full-screen readout with radial sweep animation, strengths/weaknesses, fallacy heatmap and unlocked badges — not a modal. |
| **Export** | Scorecard → 1080×1350 PNG (share sheet on mobile) or print-to-PDF. |

### Progression
| | |
|---|---|
| **Session history** | Per-user, cookie-scoped. Open any past debate: replay turns, re-read the verdict, delete. |
| **Stats dashboard** | Win rate, average/best score, current/best/day streaks, most common fallacy, persona breakdown, recent-score sparkline. |
| **Achievements** | 10 badges — First Blood, Fallacy-Free Round, Steelman Slayer, Comeback Win, Marathon, Decisive Victory, Polyglot, Hat Trick, Veteran, Persona Tour. |

### Platform
| | |
|---|---|
| **PWA** | Installable; manifest + full icon set (SVG, 192, 512, maskable). |
| **Offline shell** | Service worker caches the app shell so the HUD boots offline and shows a *LINK LOST* banner. API calls are never cached. |
| **Themes** | Ultron (red/orange), JARVIS (blue), Vision (gold). |
| **Accessibility** | Full keyboard operation (Space = core, T = type, Esc = close), focus traps in sheets, ARIA live regions, `prefers-reduced-motion` support, CSS-3D fallback when WebGL is unavailable. |
| **Admin panel** | `/admin` — env-gated (`ADMIN_ENABLED`) and token-protected. Shows model, DB backend, p50/p95 latency, error rate, last 100 events. |

### Production hardening
- Valid Groq model (`llama-3.3-70b-versatile`) — configurable via `GROQ_MODEL`. The original `qwen/qwen3.8-27b` was not a real Groq model id.
- `debug=True` removed; the app never runs the Flask dev server in production.
- API key from **environment variables only** in production. `.env` / `local_config.py` fallbacks work only outside production.
- Retry with exponential back-off + jitter on every LLM call; in-character fallback (*"Recalibrating... state your point again."*) when Groq is unreachable so the UI never breaks.
- Rate limiting (Flask-Limiter) keyed by user cookie → IP fallback.
- Structured JSON logging to stdout (request id, method, path, status, latency, model; **no** transcripts or keys).
- Locked-down CORS — same-origin by default; `CORS_ORIGINS` allow-list when needed.
- Signed-cookie sessions; per-user data isolation on every session/stats/settings route.
- `/health` endpoint for Render health checks (reports DB status + whether the LLM key is configured).
- 35 pytest tests covering every route, JSON extraction, retries and fallbacks.

---

## Local setup

```bash
git clone https://github.com/ngl-ankit/nemesis.git
cd nemesis/nemesis                     # note: the Flask app lives in the inner folder

python -m venv .venv && source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt -r requirements-dev.txt

cp .env.example .env                   # then paste your GROQ_API_KEY into .env
```

Get a free key at <https://console.groq.com/keys>.

### Run (development)

```bash
python app.py                          # http://127.0.0.1:5000 (Flask dev server, dev only)
```

### Run (production-like, Gunicorn)

```bash
PORT=8000 gunicorn app:app -c gunicorn.conf.py    # http://127.0.0.1:8000
```

This is exactly the command Render runs (`Procfile` / `render.yaml`). Gunicorn uses threaded
workers (`gthread`, 8 threads) so SSE streams don't block other requests.

### Run the tests

```bash
pytest -q tests          # 35 passed
```

> **Browser support:** speech recognition needs Chrome/Edge (desktop or Android). Safari/Firefox
> can use text input and still get TTS. Microphone requires HTTPS or `localhost`.

---

## Environment variables

| Variable | Required | Default | Notes |
|---|---|---|---|
| `GROQ_API_KEY` | **Yes** (prod) | — | Groq API key. In production it must come from the environment. Locally `.env` or `local_config.py` also work. |
| `GROQ_MODEL` | No | `llama-3.3-70b-versatile` | Any Groq chat model id, e.g. `llama-3.1-8b-instant` for lower latency. |
| `SECRET_KEY` | **Yes** (prod) | dev fallback | Signs the session cookie. App refuses to boot in production without it. |
| `FLASK_ENV` | No | `development` | Set to `production` on Render. `RENDER=true` (auto-set by Render) also implies production. |
| `DATABASE_URL` | No | — | Postgres connection string. When set, Postgres is used; otherwise SQLite. |
| `DATABASE_PATH` | No | `./nemesis.db` | SQLite file path (only used when `DATABASE_URL` is unset). Point at a Persistent Disk if you choose that route. |
| `CORS_ORIGINS` | No | *(empty = same-origin only)* | Comma-separated allow-list. Leave empty unless a separate frontend calls the API. |
| `RATELIMIT_DEFAULT` | No | `120 per minute` | Global limit. |
| `RATELIMIT_DEBATE` | No | `20 per minute` | `/api/debate` and `/api/debate/stream`. |
| `RATELIMIT_FALLACY` | No | `20 per minute` | `/api/fallacy` and `/api/strength`. |
| `RATELIMIT_SCORECARD` | No | `6 per minute` | `/api/scorecard`. |
| `RATELIMIT_STORAGE_URI` | No | `memory://` | Per-process in-memory store. Point at Redis (`redis://…`) for shared limits across workers. |
| `ADMIN_ENABLED` | No | `false` | Enables `/admin` and `/api/admin/diagnostics`. |
| `ADMIN_TOKEN` | If admin enabled | — | Sent as `X-Admin-Token` header (or `?token=` once; the page stores it in `sessionStorage`). |
| `LOG_LEVEL` | No | `INFO` | `DEBUG` / `INFO` / `WARNING`. |
| `WEB_CONCURRENCY` | No | `2` | Gunicorn worker count (read by `gunicorn.conf.py`). |
| `PORT` | No | `10000` | Injected by Render. |
| `APP_VERSION` | No | `dev` / Render commit SHA | Shown in HUD telemetry and cache-busts static assets. |

---

## Deploying to Render

The repo ships a **Render Blueprint** (`render.yaml`) that provisions the web service **and** a
managed Postgres database in one step.

### Option A — Blueprint (recommended, ~3 minutes)

1. Push this repository to GitHub (already at `github.com/ngl-ankit/nemesis`).
2. In the Render dashboard click **New → Blueprint**, pick the repo, branch `main`.
3. Render reads `render.yaml` and shows the plan: web service `nemesis` + Postgres `nemesis-db`.
   Click **Apply**.
4. You'll be prompted for the one secret marked `sync: false`: **`GROQ_API_KEY`** — paste your key.
   `SECRET_KEY` and `ADMIN_TOKEN` are auto-generated; `DATABASE_URL` is wired from the database.
5. Wait for the first deploy. Health check hits `/health`; when it returns
   `{"status":"ok","db_ok":true,"llm_configured":true,...}` you're live at
   `https://nemesis-<hash>.onrender.com`.
6. Open the URL in Chrome, allow the microphone, say *"Wake up, Ultron"*.

Every push to `main` auto-deploys (`autoDeploy: true`).

### Option B — manual web service

1. **New → Web Service**, connect the repo.
2. Settings:
   - **Root Directory:** `nemesis`
   - **Runtime:** Python 3
   - **Build Command:** `pip install -r requirements.txt`
   - **Start Command:** `gunicorn app:app -c gunicorn.conf.py`
   - **Health Check Path:** `/health`
3. **Environment** tab — add:
   `FLASK_ENV=production`, `PYTHON_VERSION=3.12.7`, `GROQ_API_KEY=…`,
   `GROQ_MODEL=llama-3.3-70b-versatile`, `SECRET_KEY=<generate>`, `WEB_CONCURRENCY=2`.
4. Storage — choose **one** of the two options below and add the matching variable.
5. Create the service.

### Optional: enable the admin panel

Set `ADMIN_ENABLED=true` and a long random `ADMIN_TOKEN`, redeploy, then visit
`/admin` and paste the token. Keep it disabled on public instances unless you need it.

### Optional: use a faster model

Set `GROQ_MODEL=llama-3.1-8b-instant` for ~2× faster first-token latency at some quality cost.
No code change required.

---

## Storage decision

Render's filesystem is **ephemeral** — every deploy and every restart wipes it, so the original
`nemesis.db` SQLite file would silently lose all history. Two fixes are supported; both are
production-ready and switching is a single env var.

| | **Render Postgres** (default in `render.yaml`) | **Persistent Disk + SQLite** |
|---|---|---|
| How | Set `DATABASE_URL` (Blueprint wires it automatically) | Attach a disk at e.g. `/var/data`, set `DATABASE_PATH=/var/data/nemesis.db` |
| Survives deploys/restarts | ✅ | ✅ |
| Multiple Gunicorn workers | ✅ Connection pool, no lock contention | ⚠️ Fine at `WEB_CONCURRENCY=1`; SQLite write locks under higher concurrency |
| Horizontal scaling (>1 instance) | ✅ | ❌ Disk is bound to one instance |
| Backups | Managed daily snapshots (paid plans) | Manual |
| Cost | Free tier exists (expires after 90 days, then from $7/mo) | Disk from $0.25/GB/mo; **not available on the free web tier** |
| Zero-downtime deploys | ✅ | ❌ Disks force a brief restart |
| Local parity | Local dev still uses SQLite — same schema, same code paths | Identical |

**We chose Postgres** because it works with the default 2 workers, allows scaling, and needs no
special disk mounting. If you prefer the disk route (simpler mental model, no DB expiry), delete
the `databases:` block and the `DATABASE_URL` entry from `render.yaml`, add a disk in the Render
UI, and set `DATABASE_PATH` — nothing else changes. `database.py` translates placeholders and
`RETURNING` semantics so both backends run the same SQL.

---

## API reference

All `/api/*` routes are JSON. Sessions are scoped by a signed `uid` cookie set on first request.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/` | HUD |
| `GET` | `/health` | `{status, db, db_ok, llm_configured, model, version}` |
| `GET` | `/api/config` | Public runtime config (model, personas, difficulties, languages, limits) |
| `GET` | `/api/topics` | Topic starter deck |
| `POST` | `/api/debate` | `{opinion, persona, history, difficulty, aggression, language}` → `{response, fallback}` |
| `POST` | `/api/debate/stream` | Same body; SSE stream — `event: meta` → `event: delta`* → `event: done` |
| `POST` | `/api/fallacy` | `{argument}` → `{fallacy_detected, fallacy_name, explanation, confidence}` |
| `POST` | `/api/strength` | `{argument, topic}` → `{score, justification}` |
| `POST` | `/api/scorecard` | `{transcript, fallacies, persona}` → full verdict JSON |
| `POST` | `/api/session/save` | Persist a finished debate → `{ok, id, new_achievements[], stats}` |
| `GET` | `/api/session/history` | Current user's sessions (newest first) |
| `GET` / `DELETE` | `/api/session/<id>` | Single session detail / delete |
| `GET` | `/api/stats` | Dashboard aggregates |
| `GET` | `/api/achievements` | All badges + unlocked state |
| `GET` / `POST` | `/api/settings` | Server-synced user preferences (whitelisted keys) |
| `GET` | `/admin` · `/api/admin/diagnostics` | Env-gated, token-protected diagnostics |
| `GET` | `/manifest.webmanifest` · `/sw.js` | PWA assets |

Errors on `/api/*` are always JSON: `{"error": "<code>", "message": "..."}` with the proper status
(400 validation, 403 forbidden, 404, 429 rate-limited, 500).

---

## Design system

**Concept:** JARVIS × Age-of-Ultron holographic HUD. A single glowing hexagonal reactor core is
the interface's heart; everything else is instrumentation orbiting it.

### Colour
| Token | Value | Use |
|---|---|---|
| `--bg` | `#020304` | Base — near-black, never pure black |
| `--a1` | `#ff3b1f` | Alert red — fallacies, glitches, primary CTA edge |
| `--a2` | `#ff8a3c` | Core orange — rings, gauges, active states |
| `--a3` | `#ffe9d6` | Warm white — headings, primary numerals |
| `--c1` | `#00d2ff` | Cyan — **sparingly**: Nemesis-side data, secondary ring, node markers |
| `--ink` / `--ink-dim` / `--ink-faint` | `#e9eef3 / #8f9aa6 / #4b5560` | Body text hierarchy |

Theme overrides (`[data-theme="jarvis"]`, `[data-theme="vision"]`) swap only the accent tokens,
so every component re-skins automatically.

### Typography
- **Chakra Petch** — HUD labels, headings, numerals (letter-spaced, uppercase)
- **Inter** — transcript/body copy (readability first)
- **JetBrains Mono** — telemetry, timestamps, IDs, buttons

### Motion
- Ambient ring rotation is slow (30–90 s per revolution) and counter-rotating; parallax follows the pointer at ≤ 6°.
- **Wake sequence** (~1.3 s): rings snap to alignment → core flares → synthesized WebAudio chime.
- Core pulses per spoken word via `SpeechSynthesisUtterance.onboundary`, with an amplitude proxy while text streams in.
- Fallacy: 400 ms red glitch (clip-path jitter + chromatic offset) on the bubble, callout line drawn to the core.
- Scorecard: radial sweep, staggered row reveal.
- `prefers-reduced-motion`: all rotations/pulses disabled; state changes become instant opacity/colour transitions.

### Layout
- Desktop (> 860 px): 3-column grid — left panels · core · right panels; transcript below; dock pinned bottom. Sheets slide in from the right.
- Mobile: core first, panels collapse into a horizontally swipeable strip, transcript scrolls, dock stays thumb-reachable. Sheets become bottom sheets. Safe-area insets respected.
- Panels use angular `clip-path` cuts and a glowing connector line toward the core; corner brackets frame the viewport with live telemetry (session id, model, latency, UTC clock, network state, turn/fallacy counters).

### Accessibility
Focus rings on every interactive element, `role="radiogroup"` persona selector, `aria-live` status
and transcript, focus trapping inside sheets, Escape to close, full keyboard path to every feature,
4.5:1 contrast for body text, and a CSS-only ring animation fallback when WebGL is missing.

---

## Testing & verification

```bash
cd nemesis
pytest -q tests                                          # unit + route tests (35)
PORT=8000 gunicorn app:app -c gunicorn.conf.py           # production server
curl -s localhost:8000/health                            # → {"status":"ok",...}
```

Verified in this build:
- ✅ 35/35 tests pass
- ✅ Serves under Gunicorn (gthread) with structured JSON request logs
- ✅ `/`, `/health`, `/manifest.webmanifest`, `/sw.js`, icons, `/admin` (403 without token, 200 with) all respond correctly
- ✅ Headless Chromium: zero console errors on desktop (1440×900) and mobile (390×844) viewports
- ✅ Full text-mode flow — topics sheet → settings → two debate turns → END DEBATE → scorecard HUD (badges unlocked) → history → stats — zero JS errors
- ✅ LLM-offline fallback path produces in-character "Recalibrating…" responses and a graceful scorecard

---

## Project structure

```
nemesis/                     ← repo root (Procfile, render.yaml, README.md, ecosystem.config.cjs)
└── nemesis/                 ← Flask app (Render rootDir)
    ├── app.py               routes, sessions, SSE, rate limiting, logging
    ├── config.py            env resolution, production guards
    ├── llm_client.py        Groq calls, retries, fallbacks, streaming, JSON extraction
    ├── prompts.py           persona / difficulty / aggression / language prompt builders
    ├── database.py          SQLite ⇄ Postgres compatibility layer, stats, achievements
    ├── achievements.py      badge definitions + unlock rules
    ├── topics.json          starter deck
    ├── gunicorn.conf.py     gthread workers, PORT binding, proxy headers
    ├── requirements.txt / requirements-dev.txt
    ├── .env.example
    ├── templates/
    │   ├── index.html       HUD markup
    │   └── admin.html       diagnostics panel
    ├── static/
    │   ├── style.css        design system
    │   ├── reactor.js       Three.js core + rings + wake sequence + chime
    │   ├── script.js        app controller (speech, SSE, panels, sheets, scorecard, export)
    │   ├── sw.js            service worker
    │   ├── manifest.webmanifest
    │   └── icons/           icon.svg · icon-192.png · icon-512.png · icon-512-maskable.png
    └── tests/               pytest suite
```

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| Every reply is *"Recalibrating... state your point again."* | `GROQ_API_KEY` is missing/invalid, or `GROQ_MODEL` isn't a valid Groq id. Check `/health` → `llm_configured`. |
| `RuntimeError: SECRET_KEY must be set in production` | Add `SECRET_KEY` in Render env (Blueprint does this automatically). |
| History disappears after deploy | You're on ephemeral SQLite. Set `DATABASE_URL` or use a Persistent Disk (see [Storage decision](#storage-decision)). |
| Mic button does nothing | Speech recognition requires Chrome/Edge and HTTPS (or `localhost`). Use the text input elsewhere. |
| 429 responses | Rate limits hit (`RATELIMIT_DEBATE` default 20/min per user). Raise the limit or wait. |
| `/admin` returns 404 | `ADMIN_ENABLED` is not `true`. 403 means the token is wrong. |
| Core is flat / no 3D | WebGL unavailable — the CSS fallback engages automatically (`body.no-webgl`). |

---

MIT © ngl-ankit
