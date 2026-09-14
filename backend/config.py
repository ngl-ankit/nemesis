"""Centralised configuration for Nemesis.

Resolution rules
----------------
* ``IS_PRODUCTION`` is true when ``FLASK_ENV``/``NEMESIS_ENV`` == "production"
  or when running on Render (``RENDER`` env var is set).
* In production **only** real environment variables are consulted.
* Outside production we additionally load a ``.env`` file (python-dotenv).

AI model
--------
Nemesis uses **openai/gpt-oss-20b** (OpenAI's open-weight 20B reasoning model)
through any OpenAI-compatible chat-completions endpoint. The default provider
is Groq (``https://api.groq.com/openai/v1``), which hosts gpt-oss-20b.
``LLM_MODEL`` exists only so the same code can be pointed at another host of
the same model.
"""

from __future__ import annotations

import os
import secrets


def _truthy(value: str | None) -> bool:
    return str(value or "").strip().lower() in {"1", "true", "yes", "on"}


def _env(*names: str, default: str = "") -> str:
    """Return the first non-empty environment variable among ``names``."""
    for name in names:
        value = os.environ.get(name, "")
        if value and value.strip():
            return value.strip()
    return default


ENV_NAME = (os.environ.get("FLASK_ENV") or os.environ.get("NEMESIS_ENV") or "development").lower()
IS_PRODUCTION = ENV_NAME == "production" or bool(os.environ.get("RENDER"))
IS_TESTING = _truthy(os.environ.get("NEMESIS_TESTING"))

if not IS_PRODUCTION:
    try:
        from dotenv import load_dotenv

        load_dotenv(os.path.join(os.path.dirname(__file__), ".env"))
        load_dotenv()
    except ImportError:  # pragma: no cover - dotenv is in requirements
        pass

# --- LLM -------------------------------------------------------------------
DEFAULT_MODEL = "openai/gpt-oss-20b"
DEFAULT_BASE_URL = "https://api.groq.com/openai/v1"

# ``LLM_*`` are canonical; ``GROQ_*`` accepted for backwards compatibility.
LLM_API_KEY: str = _env("LLM_API_KEY", "GROQ_API_KEY")
LLM_MODEL: str = _env("LLM_MODEL", "GROQ_MODEL", default=DEFAULT_MODEL)
LLM_BASE_URL: str = _env("LLM_BASE_URL", "GROQ_BASE_URL", default=DEFAULT_BASE_URL)
LLM_TIMEOUT_S: float = float(_env("LLM_TIMEOUT_S", default="30"))
LLM_MAX_RETRIES: int = int(_env("LLM_MAX_RETRIES", default="3"))

# gpt-oss-20b is a reasoning model: it spends completion tokens on hidden
# reasoning before emitting visible text. "low" keeps that overhead small so
# short spoken replies are never swallowed. Set to "" to omit the parameter.
LLM_REASONING_EFFORT: str = _env("LLM_REASONING_EFFORT", "GROQ_REASONING_EFFORT", default="low").lower()

# --- Flask -----------------------------------------------------------------
_secret = os.environ.get("SECRET_KEY", "").strip()
if not _secret:
    if IS_PRODUCTION:
        raise RuntimeError("SECRET_KEY environment variable is required in production.")
    _secret = "dev-" + secrets.token_hex(16)
SECRET_KEY: str = _secret

CORS_ORIGINS: list[str] = [o.strip() for o in os.environ.get("CORS_ORIGINS", "").split(",") if o.strip()]
SESSION_DAYS: int = int(_env("SESSION_DAYS", default="30"))
ALLOW_REGISTRATION: bool = not _truthy(os.environ.get("DISABLE_REGISTRATION"))

# --- Storage ---------------------------------------------------------------
DATABASE_URL: str = os.environ.get("DATABASE_URL", "").strip()
DATABASE_PATH: str = os.environ.get("DATABASE_PATH", os.path.join(os.path.dirname(__file__), "nemesis.db"))

# --- Rate limiting -----------------------------------------------------------
RATELIMIT_STORAGE_URI: str = os.environ.get("RATELIMIT_STORAGE_URI", "memory://")
RATELIMIT_DEBATE: str = os.environ.get("RATELIMIT_DEBATE", "20 per minute")
RATELIMIT_FALLACY: str = os.environ.get("RATELIMIT_FALLACY", "30 per minute")
RATELIMIT_SCORECARD: str = os.environ.get("RATELIMIT_SCORECARD", "6 per minute")
RATELIMIT_AUTH: str = os.environ.get("RATELIMIT_AUTH", "10 per minute")
RATELIMIT_DEFAULT: str = os.environ.get("RATELIMIT_DEFAULT", "120 per minute")

# --- Admin / debug panel -----------------------------------------------------
ADMIN_ENABLED: bool = _truthy(os.environ.get("ADMIN_ENABLED"))
ADMIN_TOKEN: str = os.environ.get("ADMIN_TOKEN", "").strip()

# --- Misc ------------------------------------------------------------------
LOG_LEVEL: str = os.environ.get("LOG_LEVEL", "INFO").upper()
APP_VERSION: str = os.environ.get("RENDER_GIT_COMMIT", os.environ.get("APP_VERSION", "dev"))[:12]
