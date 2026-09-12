"""Centralised configuration for Nemesis.

Resolution rules
----------------
* ``IS_PRODUCTION`` is true when ``FLASK_ENV``/``NEMESIS_ENV`` == "production"
  or when running on Render (``RENDER`` env var is set).
* In production **only** real environment variables are consulted.
* Outside production we additionally load a ``.env`` file (python-dotenv) and,
  as a last resort, ``nemesis/local_config.py`` (git-ignored) for the Groq key.
"""

from __future__ import annotations

import os
import secrets


def _truthy(value: str | None) -> bool:
    return str(value or "").strip().lower() in {"1", "true", "yes", "on"}


ENV_NAME = (os.environ.get("FLASK_ENV") or os.environ.get("NEMESIS_ENV") or "development").lower()
IS_PRODUCTION = ENV_NAME == "production" or bool(os.environ.get("RENDER"))
IS_TESTING = _truthy(os.environ.get("NEMESIS_TESTING"))

if not IS_PRODUCTION:
    # Local development convenience only — never runs on Render.
    try:
        from dotenv import load_dotenv

        load_dotenv(os.path.join(os.path.dirname(__file__), ".env"))
        load_dotenv()  # also honour a repo-root .env when run from the root
    except ImportError:  # pragma: no cover - dotenv is in requirements
        pass


def _resolve_groq_key() -> str:
    key = os.environ.get("GROQ_API_KEY", "").strip()
    if key or IS_PRODUCTION:
        return key
    try:  # local dev fallback (file is git-ignored)
        from local_config import GROQ_API_KEY as local_key  # type: ignore

        return str(local_key or "").strip()
    except ImportError:
        return ""


# --- LLM -------------------------------------------------------------------
GROQ_API_KEY: str = _resolve_groq_key()
GROQ_MODEL: str = os.environ.get("GROQ_MODEL", "llama-3.3-70b-versatile").strip() or "llama-3.3-70b-versatile"
GROQ_BASE_URL: str = os.environ.get("GROQ_BASE_URL", "https://api.groq.com/openai/v1")
LLM_TIMEOUT_S: float = float(os.environ.get("LLM_TIMEOUT_S", "20"))
LLM_MAX_RETRIES: int = int(os.environ.get("LLM_MAX_RETRIES", "3"))

# Reasoning models (Groq's ``openai/gpt-oss-*``, OpenAI ``o``-series) spend
# completion tokens on hidden reasoning *before* emitting any visible content.
# "low" keeps that overhead small so our deliberately short spoken replies are
# not swallowed whole. Set to "" to omit the parameter for non-reasoning models.
GROQ_REASONING_EFFORT: str = os.environ.get("GROQ_REASONING_EFFORT", "low").strip().lower()

# --- Flask -----------------------------------------------------------------
_secret = os.environ.get("SECRET_KEY", "").strip()
if not _secret:
    if IS_PRODUCTION:
        # Fail loudly rather than silently issuing forgeable session cookies.
        raise RuntimeError("SECRET_KEY environment variable is required in production.")
    _secret = "dev-" + secrets.token_hex(16)
SECRET_KEY: str = _secret

# Comma-separated list of allowed origins. Empty => same-origin only.
CORS_ORIGINS: list[str] = [o.strip() for o in os.environ.get("CORS_ORIGINS", "").split(",") if o.strip()]

# --- Storage ---------------------------------------------------------------
DATABASE_URL: str = os.environ.get("DATABASE_URL", "").strip()
DATABASE_PATH: str = os.environ.get("DATABASE_PATH", os.path.join(os.path.dirname(__file__), "nemesis.db"))

# --- Rate limiting -----------------------------------------------------------
RATELIMIT_STORAGE_URI: str = os.environ.get("RATELIMIT_STORAGE_URI", "memory://")
RATELIMIT_DEBATE: str = os.environ.get("RATELIMIT_DEBATE", "20 per minute")
RATELIMIT_FALLACY: str = os.environ.get("RATELIMIT_FALLACY", "20 per minute")
RATELIMIT_SCORECARD: str = os.environ.get("RATELIMIT_SCORECARD", "6 per minute")
RATELIMIT_DEFAULT: str = os.environ.get("RATELIMIT_DEFAULT", "120 per minute")

# --- Admin / debug panel -----------------------------------------------------
ADMIN_ENABLED: bool = _truthy(os.environ.get("ADMIN_ENABLED"))
ADMIN_TOKEN: str = os.environ.get("ADMIN_TOKEN", "").strip()

# --- Misc ------------------------------------------------------------------
LOG_LEVEL: str = os.environ.get("LOG_LEVEL", "INFO").upper()
APP_VERSION: str = os.environ.get("RENDER_GIT_COMMIT", os.environ.get("APP_VERSION", "dev"))[:12]
