# NEMESIS — Voice-Based AI Debate Opponent

> *Argue. Get dismantled. Improve.*

Nemesis is a voice-first debate sparring partner. Sign in, state an opinion, and one of four
personas — **JARVIS · ULTRON · VISION · THANOS** — fires back a counter-argument, scans your
reasoning for logical fallacies in real time, grades every point against a rubric, and issues a
scorecard at the end. Everything runs inside a holographic HUD with a live Three.js reactor core.

**AI model: `openai/gpt-oss-20b`** — used for every debate reply, fallacy scan, strength grade and
scorecard. It is reached through an OpenAI-compatible chat-completions endpoint (Groq by default).

**Stack:** Python 3.12 · Flask 3 · Gunicorn · OpenAI SDK (→ `openai/gpt-oss-20b`) · SQLite / Postgres ·
vanilla JS (ES modules) · Three.js · Web Speech API (STT + TTS) · PWA.

---

## Contents

1. [Features](#features)
2. [Architecture](#architecture)
3. [Local setup](#local-setup)
4. [Environment variables](#environment-variables)
5. [Database](#database)
6. [Authentication](#authentication)
7. [Voice / TTS](#voice--tts)
8. [Scoring](#scoring)
9. [Deploying to Render](#deploying-to-render)
10. [API reference](#api-reference)
11. [Project structure](#project-structure)
12. [Limitations & troubleshooting](#limitations--troubleshooting)

---

## Features

### Accounts
| | |
|---|---|
| **Auth-first** | The sign-in / create-account screen is the first thing you see. Nothing (mic, voice, data) starts before a session exists. |
| **Database accounts** | Users live in the `users` table; passwords are hashed with scrypt (PBKDF2 fallback). |
| **Persistent sessions** | Signed, HttpOnly, SameSite cookie carrying only the user id (30 days by default). Survives reloads and browser restarts. |
| **Per-user data** | Debates, stats, achievements and settings are scoped to the authenticated user's database id. |
| **Synced settings** | Persona, difficulty, aggression, language, voice, wake phrase, timer — stored server-side and restored on every login/device. |

### Debate engine
| | |
|---|---|
| **Voice in / voice out** | Web Speech API recognition with interim results; SpeechSynthesis playback, sentence-queued so speech starts before the model finishes. |
| **Streaming responses** | `/api/debate/stream` is Server-Sent Events — tokens land on screen as `openai/gpt-oss-20b` generates them. |
| **Four personas** | Each has its own system prompt, colour palette, sigil, and voice identity (pitch/rate/timbre). |
| **Difficulty** | Novice / Adept / Mythic — steelmanning depth, concession rate, verbosity. |
| **Aggression slider** | 0–100 tone dial injected into the system prompt. |
| **Topic deck** | 25 curated prompts across 5 categories. |
| **Round timer** | Optional per-turn countdown ring. |
| **Wake phrase** | Default *"wake up"*; configurable; optional always-listen. |
| **Multi-language** | English, Spanish, French, German, Italian, Portuguese, Hindi, Japanese, Chinese, or auto-detect. |

### Analysis
| | |
|---|---|
| **Live fallacy scan** | Every point is checked by the model; flags trigger a HUD callout and cost points. |
| **Argument-strength gauge** | Rubric-graded (evidence · logic · relevance · clarity) 0–100 per point, length-capped. |
| **Scorecard** | Independent 0–100 scores for you and Nemesis, letter grade, win/loss/draw, full rubric breakdown, strengths/weaknesses, fallacy heatmap, penalties and caps shown transparently. |
| **Export** | PNG image or print-to-PDF. |

### Progression & platform
Per-user session archive with replay, stats dashboard (W/L/D, averages, streaks, top fallacy,
recent scores), 10 achievements, PWA (installable, offline shell), persona themes, keyboard/ARIA
accessibility, reduced-motion support, env-gated admin diagnostics panel.

---

## Architecture

```
Browser (frontend/)                          Flask + Gunicorn (backend/)
┌─────────────────────────┐   cookie session  ┌───────────────────────────────┐
│ auth gate → boot → HUD  │ ───────────────▶ │ auth.py     register/login/me │
│ Web Speech STT          │   JSON / SSE      │ app.py      routes, SSE, limits│
│ Web Speech TTS (persona │ ◀─────────────── │ llm_client  openai/gpt-oss-20b │
│   identity × language)  │                   │ scoring.py  deterministic math │
│ Three.js reactor        │                   │ database.py SQLite ⇄ Postgres  │
└─────────────────────────┘                   └──────────────┬────────────────┘
                                                             │ OpenAI-compatible API
                                                             ▼
                                              openai/gpt-oss-20b (Groq by default)
```

The Flask app serves the HUD and the API from one origin, so no CORS is needed by default.

---

## Local setup

```bash
git clone https://github.com/ngl-ankit/nemesis.git
cd nemesis/backend

python -m venv .venv && source .venv/bin/activate     # Windows: .venv\Scripts\activate
pip install -r requirements.txt

cp .env.example .env        # paste your LLM_API_KEY (key for the provider hosting gpt-oss-20b)
```

Get a free Groq key (hosts `openai/gpt-oss-20b`) at <https://console.groq.com/keys>.

```bash
python app.py                                        # dev server → http://127.0.0.1:5000
PORT=8000 gunicorn app:app -c gunicorn.conf.py       # production server (what Render runs)
```

Open the URL in **Chrome or Edge** (speech recognition), create an account, tap **ENGAGE**, allow
the microphone, say *"wake up"*.

Tests: `cd backend && pip install pytest && python -m pytest -q`.

---

## Environment variables

| Variable | Required | Default | Notes |
|---|---|---|---|
| `LLM_API_KEY` | **Yes** | — | API key for the OpenAI-compatible provider hosting `openai/gpt-oss-20b`. `GROQ_API_KEY` is accepted as an alias. |
| `LLM_MODEL` | No | `openai/gpt-oss-20b` | The Nemesis model. Leave as is. |
| `LLM_BASE_URL` | No | `https://api.groq.com/openai/v1` | Any OpenAI-compatible endpoint that serves gpt-oss-20b. |
| `LLM_REASONING_EFFORT` | No | `low` | gpt-oss-20b is a reasoning model; `low` keeps hidden reasoning from eating the reply budget. |
| `LLM_TIMEOUT_S` / `LLM_MAX_RETRIES` | No | `30` / `3` | Per-call timeout and retry count. |
| `SECRET_KEY` | **Yes** (prod) | dev random | Signs the auth session cookie. App refuses to boot in production without it. |
| `SESSION_DAYS` | No | `30` | Session cookie lifetime. |
| `DISABLE_REGISTRATION` | No | `false` | Set `true` to close sign-ups on a private instance. |
| `FLASK_ENV` | No | `development` | `production` on Render (`RENDER=true` also implies production). |
| `DATABASE_URL` | No | — | Postgres connection string. When set, Postgres is used; otherwise SQLite. |
| `DATABASE_PATH` | No | `backend/nemesis.db` | SQLite path (only when `DATABASE_URL` is unset). |
| `CORS_ORIGINS` | No | *(same-origin only)* | Comma-separated allow-list; only if a separate frontend origin calls `/api`. |
| `RATELIMIT_DEFAULT` / `_DEBATE` / `_FALLACY` / `_SCORECARD` / `_AUTH` | No | `120` / `20` / `30` / `6` / `10 per minute` | Rate limits. |
| `RATELIMIT_STORAGE_URI` | No | `memory://` | Point at Redis for shared limits across workers. |
| `ADMIN_ENABLED` / `ADMIN_TOKEN` | No | `false` / — | Enables `/admin` diagnostics behind `X-Admin-Token`. |
| `LOG_LEVEL`, `WEB_CONCURRENCY`, `PORT`, `APP_VERSION` | No | `INFO`, `2`, `10000`, Render SHA | Ops knobs. |

---

## Database

Schema is created automatically on first boot; additive migrations run on upgrade.

- `users` — id, email (unique), display_name, password_hash, created_at, last_login_at
- `sessions` — per-user debates: transcript, fallacies, strengths, scores, scorecard JSON
- `achievements` — per-user unlocked badges
- `user_settings` — per-user JSON preferences
- `event_log` — metadata-only latency/error log for the admin panel

**Local:** SQLite file (zero config). **Render:** managed Postgres via `DATABASE_URL` (wired by the
Blueprint). The same SQL runs on both — `database.py` translates placeholders and `RETURNING`.

---

## Authentication

- `POST /api/auth/register` `{email, password, display_name}` → creates the account, signs in (201)
- `POST /api/auth/login` `{email, password}` → 200 + session cookie, or 401
- `POST /api/auth/logout` · `GET /api/auth/me` → `{authenticated, user}`
- `POST /api/auth/profile` `{display_name}` / `{current_password, new_password}`

Every other `/api/*` route (except `/api/config`, `/api/topics`, admin) returns **401** without a
valid session; the frontend drops back to the auth gate automatically. Credential endpoints are
rate limited per IP. Passwords must be ≥ 8 characters. Cookies are `HttpOnly`, `SameSite=Lax` and
`Secure` in production.

Verified flow: Register → DB record → Login → HUD → per-user sessions/settings → Logout → Login
again → data and settings persist (covered by `backend/tests/test_app.py`).

---

## Voice / TTS

Nemesis uses the browser's **Web Speech API** for both recognition and synthesis — zero server
cost, no audio leaves the device. An earlier Kokoro TTS experiment was removed: it required a
multi-hundred-MB model download and was unstable on the free tier.

**Character identity is independent of language.** Each persona defines a voice identity —
pitch, rate, gender preference and preferred timbres. When you speak Hindi (or lock Hindi in
settings), the engine picks the best *Hindi* voice the browser has and applies the same persona
prosody on top. JARVIS + English, JARVIS + Hindi and JARVIS + Spanish are the same character
speaking different languages; the same holds for ULTRON, VISION and THANOS. Wake, sleep and
greeting lines are localised for all nine languages.

Robustness: sentence-queued playback, Chrome pause/resume keep-alive, bounded safety timeout, echo
guard (mic ignores Nemesis's own speech), explicit *AUDIO BLOCKED* / *JUDGE OFFLINE* / *AI LINK
DEGRADED* states, and a **TEST VOICE** button that reports the exact voice chosen.

> Voice quality depends on the voices installed in the OS/browser. Chrome/Edge desktop and Android
> have the widest language coverage; Safari/Firefox have no speech recognition (TTS still works).

---

## Scoring

The model only ever grades **rubric criteria on 0–10**; all numbers the user sees are computed
deterministically in `backend/scoring.py`:

- **Per-turn strength** = weighted rubric (evidence 30 % · logic 30 % · relevance 20 % · clarity 20 %),
  capped by statement length (≤ 8 words → max 30, ≤ 15 → 45, ≤ 30 → 60).
- **Final score (you)** = 70 % judge rubric (clarity, evidence, logic, rebuttal, consistency,
  persuasiveness) + 30 % live-telemetry average − **7 points per fallacy** (max 35), capped by
  depth (1 turn → 58, 2 → 72, 3 → 84).
- **Nemesis** is scored independently on its own rubric — scores no longer sum to 100, so a weak
  opponent can't inflate you and vice versa.
- **Outcome** requires a ≥ 4-point margin; otherwise it's a draw. Letter grade S/A/B/C/D/F.
- If the judge call fails, the scorecard is marked **provisional** and built from live telemetry
  only — never a fake 50/50.

The breakdown (judge score, live average, penalty, cap) is shown on the scorecard and stored with
the session.

---

## Deploying to Render

The repo ships a **Render Blueprint** (`render.yaml`): one Python web service + one managed
Postgres database.

1. Push the repo to GitHub.
2. Render dashboard → **New → Blueprint** → pick the repo, branch `main` → **Apply**.
3. Enter the single secret marked `sync: false`: **`LLM_API_KEY`**. `SECRET_KEY` and `ADMIN_TOKEN`
   are generated; `DATABASE_URL` is wired from the database.
4. Wait for the health check (`/health` → `{"status":"ok","db_ok":true,"llm_configured":true,
   "model":"openai/gpt-oss-20b"}`) and open the URL.

Blueprint details: `rootDir: backend`, build `pip install -r requirements.txt`, start
`gunicorn app:app -c gunicorn.conf.py` (gthread workers so SSE never blocks), `autoDeploy: true`.

**Manual web service:** Root Directory `backend`, Runtime Python 3, Build `pip install -r
requirements.txt`, Start `gunicorn app:app -c gunicorn.conf.py`, Health Check `/health`, env vars
from the table above (at minimum `FLASK_ENV=production`, `LLM_API_KEY`, `SECRET_KEY`, `DATABASE_URL`).

**Required external services:** an OpenAI-compatible provider hosting `openai/gpt-oss-20b` (Groq
free tier works) and a database (Render Postgres via the Blueprint, or SQLite on a Persistent Disk).

---

## API reference

All `/api/*` routes are JSON; errors are `{"error": code, "message": text}` with the proper status.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/` · `/health` · `/api/config` · `/api/topics` | — | HUD, health, public config, topic deck |
| `POST` | `/api/auth/register` · `/login` · `/logout` · `/profile` · `GET /me` | — | Accounts |
| `POST` | `/api/debate` | ✓ | `{opinion, persona, history, difficulty, aggression, language}` → `{response, lang, fallback}` |
| `POST` | `/api/debate/stream` | ✓ | Same body; SSE `meta` → `delta`* → `done {text, lang, latency_ms, fallback}` |
| `POST` | `/api/fallacy` | ✓ | `{statement}` → `{fallacy_name, explanation, confidence, fallback}` |
| `POST` | `/api/strength` | ✓ | `{statement}` → `{strength, label, rubric, fallback}` |
| `POST` | `/api/scorecard` | ✓ | `{turns, fallacies, strengths}` → `{score_you, score_nemesis, outcome, grade, breakdown, strengths, weaknesses, summary, fallback}` |
| `POST` | `/api/session/save` | ✓ | Persist a finished debate → `{ok, id, new_achievements, stats}` |
| `GET` | `/api/session/history` · `/api/session/<id>` · `DELETE /api/session/<id>` | ✓ | Archive |
| `GET` | `/api/stats` · `/api/achievements` | ✓ | Dashboard |
| `GET/POST` | `/api/settings` | ✓ | Server-synced preferences |
| `GET` | `/admin` · `/api/admin/diagnostics` | token | Env-gated diagnostics |

---

## Project structure

```
nemesis/
├── render.yaml              Render Blueprint (web service + Postgres)
├── Procfile                 fallback start command
├── README.md
├── backend/                 Flask app (Render rootDir)
│   ├── app.py               routes, auth guard, SSE, rate limiting, logging
│   ├── auth.py              register / login / logout / me / profile
│   ├── config.py            env resolution (LLM_* → openai/gpt-oss-20b), production guards
│   ├── llm_client.py        gpt-oss-20b calls, retries, streaming, evaluation prompts
│   ├── scoring.py           deterministic rubric → score math
│   ├── prompts.py           persona / difficulty / aggression / language prompts
│   ├── database.py          SQLite ⇄ Postgres layer, users, sessions, stats
│   ├── achievements.py      badge rules
│   ├── topics.json          starter deck
│   ├── gunicorn.conf.py     gthread workers, PORT binding
│   ├── requirements.txt
│   ├── tests/test_app.py    API + auth + scoring tests
│   └── .env.example
└── frontend/
    ├── templates/index.html · admin.html
    └── static/style.css · js/script.js · js/reactor.js · sw.js · manifest.webmanifest · icons/
```

---

## Limitations & troubleshooting

| Symptom | Fix |
|---|---|
| Every reply is *"Recalibrating... state your point again."* + *AI LINK DEGRADED* toast | `LLM_API_KEY` missing/invalid or the provider can't serve `openai/gpt-oss-20b`. Check `/health` → `llm_configured`. |
| Empty replies | Keep `LLM_REASONING_EFFORT=low` — gpt-oss-20b otherwise spends the token budget on hidden reasoning. |
| `RuntimeError: SECRET_KEY must be set in production` | Add `SECRET_KEY` (the Blueprint generates it). |
| Signed out unexpectedly | Sessions last `SESSION_DAYS`; changing `SECRET_KEY` invalidates all cookies. |
| Mic button does nothing | Speech recognition needs Chrome/Edge and HTTPS (or `localhost`). |
| Voice sounds wrong for a language | The browser has no voice for that language; install one in the OS or use Chrome. |
| History lost after deploy | You're on ephemeral SQLite — set `DATABASE_URL` (Blueprint does) or mount a Persistent Disk. |
| 429 responses | Rate limits hit; raise `RATELIMIT_*` or wait. |

MIT © ngl-ankit
