"""Nemesis — AI voice debate assistant. Flask entry point (served by Gunicorn)."""

from __future__ import annotations

import json
import logging
import os
import secrets
import sys
import time
import uuid
from datetime import timedelta

from flask import Flask, Response, abort, g, jsonify, render_template, request, send_from_directory, session, stream_with_context
from flask_cors import CORS
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address
from werkzeug.exceptions import HTTPException

import achievements as ach
import auth
import config
import database
import scoring
from llm_client import (
    MODEL,
    argument_strength,
    counter_argument,
    detect_fallacy,
    is_configured,
    scorecard,
    split_lang_tag,
    stream_counter_argument,
    transcribe_audio,
)
from prompts import DIFFICULTIES, LANGUAGES, PERSONAS

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
# The browser assets live in the sibling ``frontend/`` folder so the repo is
# split cleanly into frontend/ and backend/ while the internal layout of each
# half is preserved. ``NEMESIS_FRONTEND_DIR`` allows overriding the location.
FRONTEND_DIR = os.environ.get("NEMESIS_FRONTEND_DIR") or os.path.join(os.path.dirname(BASE_DIR), "frontend")
STATIC_DIR = os.path.join(FRONTEND_DIR, "static")
TEMPLATE_DIR = os.path.join(FRONTEND_DIR, "templates")

# --------------------------------------------------------------------------
# Structured logging (JSON lines to stdout — Render captures these)
# --------------------------------------------------------------------------
class _JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload = {
            "ts": self.formatTime(record, "%Y-%m-%dT%H:%M:%S"),
            "level": record.levelname,
            "logger": record.name,
            "msg": record.getMessage(),
        }
        for key in ("request_id", "method", "path", "status", "latency_ms", "model", "error", "kind"):
            val = getattr(record, key, None)
            if val is not None:
                payload[key] = val
        return json.dumps(payload, ensure_ascii=False)


_handler = logging.StreamHandler(sys.stdout)
_handler.setFormatter(_JsonFormatter())
logging.basicConfig(level=getattr(logging, config.LOG_LEVEL, logging.INFO), handlers=[_handler], force=True)
log = logging.getLogger("nemesis.app")
logging.getLogger("werkzeug").setLevel(logging.WARNING)
logging.getLogger("httpx").setLevel(logging.WARNING)

# --------------------------------------------------------------------------
# App factory bits
# --------------------------------------------------------------------------
app = Flask(__name__, static_folder=STATIC_DIR, template_folder=TEMPLATE_DIR)
app.config.update(
    SECRET_KEY=config.SECRET_KEY,
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_SECURE=config.IS_PRODUCTION,
    SESSION_COOKIE_NAME="nemesis_session",
    PERMANENT_SESSION_LIFETIME=timedelta(days=config.SESSION_DAYS),
    MAX_CONTENT_LENGTH=8 * 1024 * 1024,
    JSON_SORT_KEYS=False,
)

# CORS: same-origin by default. Only the explicitly whitelisted origins may call /api.
if config.CORS_ORIGINS:
    CORS(app, resources={r"/api/*": {"origins": config.CORS_ORIGINS}}, supports_credentials=True)


def _rate_key() -> str:
    """Rate-limit per authenticated user when available, otherwise per IP."""
    uid = session.get("user_id")
    return f"u:{uid}" if uid else f"ip:{get_remote_address()}"


limiter = Limiter(
    key_func=_rate_key,
    app=app,
    default_limits=[config.RATELIMIT_DEFAULT],
    storage_uri=config.RATELIMIT_STORAGE_URI,
    headers_enabled=True,
    enabled=not config.IS_TESTING,
)

# --------------------------------------------------------------------------
# Startup diagnostics
# --------------------------------------------------------------------------
print("NEMESIS: Flask app created", flush=True)
print("NEMESIS: Starting database initialization...", flush=True)

database.init_db()

print("NEMESIS: Database initialization complete", flush=True)

app.register_blueprint(auth.bp)
# Brute-force protection on credential endpoints (per IP, since no session yet).
limiter.limit(config.RATELIMIT_AUTH, key_func=get_remote_address)(auth.bp)

print("NEMESIS: Auth blueprint registered", flush=True)

with open(os.path.join(BASE_DIR, "topics.json"), encoding="utf-8") as fh:
    TOPICS = json.load(fh)

print("NEMESIS: Topics loaded", flush=True)


# --------------------------------------------------------------------------
# Request lifecycle: request id, user session, latency logging
# --------------------------------------------------------------------------
@app.before_request
def _before():
    g.request_id = request.headers.get("X-Request-ID") or uuid.uuid4().hex[:12]
    g.t0 = time.perf_counter()
    g.uid = None
    if request.path.startswith("/api/") and not auth.is_public_path(request.path):
        if auth.current_user() is None:
            return jsonify({"error": "unauthorized", "message": "Sign in to continue."}), 401


@app.after_request
def _after(resp: Response):
    latency_ms = int((time.perf_counter() - getattr(g, "t0", time.perf_counter())) * 1000)
    resp.headers["X-Request-ID"] = g.get("request_id", "-")
    resp.headers["X-Content-Type-Options"] = "nosniff"
    resp.headers["X-Frame-Options"] = "DENY"
    resp.headers["Referrer-Policy"] = "same-origin"
    resp.headers["Permissions-Policy"] = "microphone=(self), camera=()"
    if request.path.startswith("/api/") or request.path == "/health":
        log.info(
            "request",
            extra={
                "request_id": g.get("request_id"),
                "method": request.method,
                "path": request.path,
                "status": resp.status_code,
                "latency_ms": latency_ms,
            },
        )
    return resp


@app.errorhandler(429)
def _too_many(e):
    return jsonify({"error": "rate_limited", "message": "Too many requests. Let the core cool down."}), 429


@app.errorhandler(404)
def _not_found(e):
    if request.path.startswith("/api/"):
        return jsonify({"error": "not_found"}), 404
    return render_template("index.html", version=config.APP_VERSION, model=MODEL), 404


@app.errorhandler(Exception)
def _unhandled(e):
    if isinstance(e, HTTPException):
        if request.path.startswith("/api/"):
            return jsonify({"error": e.name.lower().replace(" ", "_"), "message": e.description}), e.code
        return e
    log.error("unhandled", extra={"request_id": g.get("request_id"), "error": e.__class__.__name__})
    database.log_event("ERROR", "unhandled", g.get("request_id"), MODEL, None, e.__class__.__name__)
    if request.path.startswith("/api/"):
        return jsonify({"error": "internal", "message": "Recalibrating... try again."}), 500
    raise e


def _body() -> dict:
    data = request.get_json(silent=True)
    return data if isinstance(data, dict) else {}


def _clean_text(value, limit=2000) -> str:
    return str(value or "").strip()[:limit]


def _debate_params(body: dict) -> dict:
    persona = body.get("persona", "jarvis")
    difficulty = body.get("difficulty", "adept")
    lang = _clean_text(body.get("language", "auto"), 8) or "auto"
    return {
        "persona": persona if persona in PERSONAS else "jarvis",
        "difficulty": difficulty if difficulty in DIFFICULTIES else "adept",
        "aggression": max(0, min(100, int(body.get("aggression", 50) or 50))),
        "language": lang if lang.split("-")[0] in LANGUAGES else "auto",
        "history": (body.get("history") or [])[-8:],
    }


def _timed(kind: str, fn):
    t0 = time.perf_counter()
    result = fn()
    ms = int((time.perf_counter() - t0) * 1000)
    database.log_event("INFO", kind, g.get("request_id"), MODEL, ms, "ok")
    return result, ms


# --------------------------------------------------------------------------
# Pages & platform
# --------------------------------------------------------------------------
@app.route("/")
def index():
    return render_template("index.html", version=config.APP_VERSION, model=MODEL)


@app.route("/manifest.webmanifest")
def manifest():
    resp = send_from_directory(STATIC_DIR, "manifest.webmanifest")
    resp.headers["Content-Type"] = "application/manifest+json"
    return resp


@app.route("/sw.js")
def service_worker():
    resp = send_from_directory(STATIC_DIR, "sw.js")
    resp.headers["Cache-Control"] = "no-cache"
    resp.headers["Service-Worker-Allowed"] = "/"
    return resp


@app.route("/health")
@limiter.exempt
def health():
    try:
        database.ping()
        db_ok = True
    except Exception as exc:  # noqa: BLE001
        log.error("health_db_failed", extra={"error": exc.__class__.__name__})
        db_ok = False
    status = 200 if db_ok else 503
    return (
        jsonify(
            {
                "status": "ok" if db_ok else "degraded",
                "db": "postgres" if database.IS_POSTGRES else "sqlite",
                "db_ok": db_ok,
                "model": MODEL,
                "llm_configured": is_configured(),
                "version": config.APP_VERSION,
            }
        ),
        status,
    )


@app.route("/api/config")
def client_config():
    return jsonify(
        {
            "model": MODEL,
            "personas": list(PERSONAS.keys()),
            "difficulties": list(DIFFICULTIES.keys()),
            "languages": LANGUAGES,
            "version": config.APP_VERSION,
            "llm_configured": is_configured(),
            "registration_open": config.ALLOW_REGISTRATION,
        }
    )


@app.route("/api/topics")
def topics():
    return jsonify(TOPICS)


@app.route("/api/transcribe", methods=["POST"])
@limiter.limit(config.RATELIMIT_TRANSCRIBE)
def transcribe_endpoint():
    audio_file = request.files.get("audio")
    if audio_file is None:
        return jsonify({"error": "missing_audio", "message": "Record audio first."}), 400

    mime = (audio_file.mimetype or "audio/webm").split(";", 1)[0].strip().lower()
    audio_bytes = audio_file.read() or b""
    if not audio_bytes:
        return jsonify({"error": "empty_audio", "message": "No speech captured. Try again."}), 400
    if len(audio_bytes) > 6 * 1024 * 1024:
        return jsonify({"error": "audio_too_large", "message": "Recording too large. Keep it under ~20 seconds."}), 413

    language = _clean_text(request.form.get("language", "auto"), 12)
    (result, _ms) = _timed("transcribe", lambda: transcribe_audio(audio_bytes, mime, language))
    text, fallback = result
    if not text:
        return (
            jsonify({
                "error": "transcription_failed",
                "message": "Could not transcribe audio. Please retry.",
                "fallback": True,
            }),
            502,
        )
    return jsonify({"text": text, "fallback": fallback, "model": config.STT_MODEL})


# --------------------------------------------------------------------------
# Debate mechanics
# --------------------------------------------------------------------------
@app.route("/api/debate", methods=["POST"])
@limiter.limit(config.RATELIMIT_DEBATE)
def debate():
    body = _body()
    opinion = _clean_text(body.get("opinion"))
    if not opinion:
        return jsonify({"error": "empty", "message": "State your point first."}), 400
    p = _debate_params(body)
    (raw, fallback), _ = _timed(
        "debate",
        lambda: counter_argument(opinion, p["persona"], p["history"], p["difficulty"], p["aggression"], p["language"]),
    )
    counter, lang = split_lang_tag(raw)
    return jsonify({"counter_argument": counter, "lang": lang, "model": MODEL, "fallback": fallback})


@app.route("/api/debate/stream", methods=["POST"])
@limiter.limit(config.RATELIMIT_DEBATE)
def debate_stream():
    """Server-Sent Events: ``delta`` events with text chunks, then ``done``."""
    body = _body()
    opinion = _clean_text(body.get("opinion"))
    if not opinion:
        return jsonify({"error": "empty", "message": "State your point first."}), 400
    p = _debate_params(body)
    request_id = g.request_id

    def generate():
        t0 = time.perf_counter()
        full = []
        fallback = False
        yield f"event: meta\ndata: {json.dumps({'model': MODEL, 'request_id': request_id})}\n\n"
        try:
            for delta, is_fallback in stream_counter_argument(
                opinion, p["persona"], p["history"], p["difficulty"], p["aggression"], p["language"]
            ):
                fallback = fallback or is_fallback
                full.append(delta)
                yield f"event: delta\ndata: {json.dumps({'t': delta})}\n\n"
        finally:
            ms = int((time.perf_counter() - t0) * 1000)
            database.log_event(
                "INFO" if not fallback else "WARN",
                "debate_stream",
                request_id,
                MODEL,
                ms,
                "ok" if not fallback else "fallback",
            )
        clean, lang = split_lang_tag("".join(full))
        yield f"event: done\ndata: {json.dumps({'text': clean, 'lang': lang, 'latency_ms': ms, 'fallback': fallback})}\n\n"

    headers = {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
        "Connection": "keep-alive",
    }
    return Response(stream_with_context(generate()), headers=headers)


@app.route("/api/fallacy", methods=["POST"])
@limiter.limit(config.RATELIMIT_FALLACY)
def fallacy():
    statement = _clean_text(_body().get("statement"))
    if not statement:
        return jsonify({"fallacy_name": "None", "explanation": "", "confidence": 0, "fallback": False})
    result, _ = _timed("fallacy", lambda: detect_fallacy(statement))
    return jsonify(result)


@app.route("/api/strength", methods=["POST"])
@limiter.limit(config.RATELIMIT_FALLACY)
def strength():
    statement = _clean_text(_body().get("statement"))
    if not statement:
        return jsonify({"strength": 0, "label": "No signal", "rubric": {}, "fallback": False})
    result, _ = _timed("strength", lambda: argument_strength(statement))
    return jsonify(result)


@app.route("/api/scorecard", methods=["POST"])
@limiter.limit(config.RATELIMIT_SCORECARD)
def scorecard_endpoint():
    body = _body()
    turns_list = body.get("turns") if isinstance(body.get("turns"), list) else []
    transcript = _clean_text(body.get("transcript"), 12000)
    if not transcript and turns_list:
        transcript = "\n".join(
            ("You: " if str(t.get("role")) == "user" else "Nemesis: ") + _clean_text(t.get("text"), 1500)
            for t in turns_list
            if isinstance(t, dict) and t.get("text")
        )[:12000]
    if not transcript:
        return jsonify({"error": "empty", "message": "Nothing to score yet."}), 400
    fallacies = [
        _clean_text(f.get("name") if isinstance(f, dict) else f, 60)
        for f in (body.get("fallacies") or [])
        if (f.get("name") if isinstance(f, dict) else f)
    ][:50]
    strengths = [s for s in (body.get("strengths") or []) if isinstance(s, (int, float))][:50]
    user_lines = [t for t in turns_list if isinstance(t, dict) and str(t.get("role")) == "user"]
    if user_lines:
        turns = len(user_lines)
        user_words = sum(scoring.word_count(t.get("text")) for t in user_lines)
    else:
        lines = [ln for ln in transcript.splitlines() if ln.startswith("You:")]
        turns = max(1, len(lines))
        user_words = sum(scoring.word_count(ln[4:]) for ln in lines)
    result, _ = _timed(
        "scorecard",
        lambda: scorecard(transcript, fallacies=fallacies, strengths=strengths, turns=turns, user_words=user_words),
    )
    return jsonify(result)


# --------------------------------------------------------------------------
# Sessions (scoped to the signed cookie's uid)
# --------------------------------------------------------------------------
@app.route("/api/session/save", methods=["POST"])
def session_save():
    body = _body()
    transcript = body.get("transcript") or []
    fallacies = body.get("fallacies") or []
    if not isinstance(transcript, list) or not isinstance(fallacies, list):
        return jsonify({"error": "bad_request"}), 400
    p = _debate_params(body)
    strengths = [s for s in (body.get("strengths") or []) if isinstance(s, (int, float))][:50]
    record = {
        "topic": _clean_text(body.get("topic"), 200) or "Untitled debate",
        "transcript": transcript[:200],
        "fallacies": fallacies[:100],
        "score_you": max(0, min(100, int(body.get("score_you", 0) or 0))),
        "score_nemesis": max(0, min(100, int(body.get("score_nemesis", 0) or 0))),
        "scorecard_text": _clean_text(body.get("scorecard_text"), 2000),
        "persona": p["persona"],
        "difficulty": p["difficulty"],
        "language": p["language"],
        "duration_s": max(0, int(body.get("duration_s", 0) or 0)),
        "strengths": strengths,
        "scorecard": body.get("scorecard") if isinstance(body.get("scorecard"), dict) else None,
    }
    session_id = database.save_session(g.uid, **record)
    stats = database.get_stats(g.uid)
    earned = ach.evaluate(record, stats)
    new_keys = database.unlock_achievements(g.uid, earned, session_id)
    return jsonify(
        {
            "ok": True,
            "id": session_id,
            "new_achievements": [{"key": k, **ach.ACHIEVEMENTS[k]} for k in new_keys],
            "stats": stats,
        }
    )


@app.route("/api/session/history", methods=["GET"])
def session_history():
    return jsonify({"sessions": database.get_sessions(g.uid)})


@app.route("/api/session/<int:session_id>", methods=["GET"])
def session_detail(session_id: int):
    record = database.get_session(g.uid, session_id)
    if not record:
        return jsonify({"error": "not_found"}), 404
    return jsonify(record)


@app.route("/api/session/<int:session_id>", methods=["DELETE"])
def session_delete(session_id: int):
    database.delete_session(g.uid, session_id)
    return jsonify({"ok": True})


@app.route("/api/stats")
def stats():
    return jsonify(database.get_stats(g.uid))


@app.route("/api/achievements")
def achievements_endpoint():
    unlocked = {a["key"]: a for a in database.get_achievements(g.uid)}
    return jsonify(
        {
            "achievements": [
                {
                    "key": key,
                    **meta,
                    "unlocked": key in unlocked,
                    "unlocked_at": unlocked.get(key, {}).get("unlocked_at"),
                }
                for key, meta in ach.ACHIEVEMENTS.items()
            ]
        }
    )


@app.route("/api/settings", methods=["GET", "POST"])
def settings_endpoint():
    if request.method == "GET":
        return jsonify(database.get_settings(g.uid))
    body = _body()
    allowed = {
        "persona", "difficulty", "aggression", "language", "theme", "wakePhrase",
        "timerEnabled", "timerSecs", "voiceProfile", "ttsEnabled", "autoListen", "ttsVolume",
    }
    clean = {k: v for k, v in body.items() if k in allowed}
    merged = {**database.get_settings(g.uid), **clean}
    database.save_settings(g.uid, merged)
    return jsonify({"ok": True, "settings": merged})


# --------------------------------------------------------------------------
# Admin / debug panel — gated behind ADMIN_ENABLED + ADMIN_TOKEN
# --------------------------------------------------------------------------
def _require_admin():
    if not config.ADMIN_ENABLED:
        abort(404)
    token = request.headers.get("X-Admin-Token") or request.args.get("token", "")
    if not config.ADMIN_TOKEN or not secrets.compare_digest(token, config.ADMIN_TOKEN):
        abort(403)


@app.route("/admin")
def admin_page():
    _require_admin()
    return render_template("admin.html", version=config.APP_VERSION)


@app.route("/api/admin/diagnostics")
def admin_diagnostics():
    _require_admin()
    return jsonify(
        {
            "model": MODEL,
            "db": "postgres" if database.IS_POSTGRES else "sqlite",
            "version": config.APP_VERSION,
            "env": config.ENV_NAME,
            "users": database.count_users(),
            "llm_configured": is_configured(),
            "latency": database.latency_summary(),
            "events": database.recent_events(100),
        }
    )


if __name__ == "__main__":  # local dev only — production runs under Gunicorn
    app.run(host="127.0.0.1", port=int(os.environ.get("PORT", 5000)))
