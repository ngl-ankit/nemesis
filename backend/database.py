"""Persistence layer for Nemesis.

Two interchangeable backends behind one tiny compatibility layer:

* **PostgreSQL** (``DATABASE_URL`` set) — used on Render so data survives
  deploys/restarts. Uses ``psycopg2``.
* **SQLite** (default) — zero-config local development, tests, or a Render
  Persistent Disk mounted at ``DATABASE_PATH``.

All queries are written with ``?`` placeholders and translated to ``%s`` for
Postgres. Every row is scoped to a ``user_id`` — the numeric primary key of the
authenticated account in ``users`` (stored as TEXT) — so history is per-user.
"""

from __future__ import annotations

import json
import sqlite3
import threading
import time
from contextlib import contextmanager
from datetime import datetime, timezone
from typing import Any, Iterable

import config

_lock = threading.RLock()
_pg_pool = None
IS_POSTGRES = config.DATABASE_URL.startswith(("postgres://", "postgresql://"))


# --------------------------------------------------------------------------
# Connection handling
# --------------------------------------------------------------------------
def _pg_url() -> str:
    url = config.DATABASE_URL
    # SQLAlchemy-style prefix is not understood by psycopg2.
    if url.startswith("postgres://"):
        url = "postgresql://" + url[len("postgres://"):]
    return url


def _get_pool():
    global _pg_pool
    if _pg_pool is None:
        from psycopg2 import pool  # imported lazily so SQLite installs don't need it

        with _lock:
            if _pg_pool is None:
                _pg_pool = pool.ThreadedConnectionPool(1, 8, dsn=_pg_url())
    return _pg_pool


class _Cursor:
    """Uniform cursor wrapper returning dict rows for both engines."""

    def __init__(self, raw, is_pg: bool):
        self._raw = raw
        self._pg = is_pg

    def execute(self, sql: str, params: Iterable[Any] = ()):
        if self._pg:
            sql = sql.replace("?", "%s")
        self._raw.execute(sql, tuple(params))
        return self

    def fetchall(self) -> list[dict]:
        rows = self._raw.fetchall()
        if self._pg:
            cols = [d[0] for d in self._raw.description]
            return [dict(zip(cols, r)) for r in rows]
        return [dict(r) for r in rows]

    def fetchone(self) -> dict | None:
        rows = self.fetchall()
        return rows[0] if rows else None

    @property
    def lastrowid(self):
        return self._raw.lastrowid


@contextmanager
def connection():
    """Yield a ``_Cursor``; commits on success, rolls back on error."""
    if IS_POSTGRES:
        pool_ = _get_pool()
        conn = pool_.getconn()
        try:
            cur = conn.cursor()
            yield _Cursor(cur, True)
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            cur.close()
            pool_.putconn(conn)
    else:
        conn = sqlite3.connect(config.DATABASE_PATH, timeout=30, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        try:
            conn.execute("PRAGMA busy_timeout=30000")
            try:
                conn.execute("PRAGMA journal_mode=WAL")
            except sqlite3.OperationalError:
                pass  # another worker holds the lock during boot; WAL is only an optimisation
            cur = conn.cursor()
            yield _Cursor(cur, False)
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()


# --------------------------------------------------------------------------
# Schema
# --------------------------------------------------------------------------
_PK = "SERIAL PRIMARY KEY" if IS_POSTGRES else "INTEGER PRIMARY KEY AUTOINCREMENT"

SCHEMA = [
    f"""
    CREATE TABLE IF NOT EXISTS users (
        id {_PK},
        email TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_login_at TEXT
    )
    """,
    f"""
    CREATE TABLE IF NOT EXISTS sessions (
        id {_PK},
        user_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        topic TEXT,
        persona TEXT,
        difficulty TEXT,
        language TEXT,
        duration_s INTEGER DEFAULT 0,
        transcript_json TEXT,
        fallacies_json TEXT,
        strengths_json TEXT,
        score_you INTEGER,
        score_nemesis INTEGER,
        scorecard_text TEXT,
        scorecard_json TEXT
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id, id DESC)",
    f"""
    CREATE TABLE IF NOT EXISTS achievements (
        id {_PK},
        user_id TEXT NOT NULL,
        key TEXT NOT NULL,
        unlocked_at TEXT NOT NULL,
        session_id INTEGER,
        UNIQUE(user_id, key)
    )
    """,
    f"""
    CREATE TABLE IF NOT EXISTS user_settings (
        user_id TEXT PRIMARY KEY,
        settings_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
    )
    """,
    f"""
    CREATE TABLE IF NOT EXISTS event_log (
        id {_PK},
        created_at TEXT NOT NULL,
        level TEXT NOT NULL,
        kind TEXT NOT NULL,
        request_id TEXT,
        model TEXT,
        latency_ms INTEGER,
        message TEXT
    )
    """,
]

_initialised = False


def _migrate(cur) -> None:
    """Additive migrations for databases created by earlier versions."""
    if IS_POSTGRES:
        cur.execute("ALTER TABLE sessions ADD COLUMN IF NOT EXISTS scorecard_json TEXT")
        return
    cols = {r["name"] for r in cur.execute("PRAGMA table_info(sessions)").fetchall()}
    if "scorecard_json" not in cols:
        cur.execute("ALTER TABLE sessions ADD COLUMN scorecard_json TEXT")


def init_db() -> None:
    global _initialised
    if _initialised:
        return
    with _lock:
        if _initialised:
            return
        # Several Gunicorn workers boot at once; SQLite may briefly be locked.
        for attempt in range(5):
            try:
                with connection() as cur:
                    for stmt in SCHEMA:
                        cur.execute(stmt)
                    _migrate(cur)
                break
            except sqlite3.OperationalError as exc:
                if "locked" not in str(exc).lower() or attempt == 4:
                    raise
                time.sleep(0.3 * (attempt + 1))
        _initialised = True


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _row_to_session(row: dict, full: bool) -> dict:
    out = {
        "id": row["id"],
        "created_at": row["created_at"],
        "topic": row["topic"],
        "persona": row.get("persona") or "ultron",
        "difficulty": row.get("difficulty") or "adept",
        "language": row.get("language") or "en",
        "duration_s": row.get("duration_s") or 0,
        "score_you": row["score_you"] or 0,
        "score_nemesis": row["score_nemesis"] or 0,
        "scorecard_text": row["scorecard_text"] or "",
        "outcome": _outcome(row["score_you"] or 0, row["score_nemesis"] or 0),
        "fallacy_count": len(json.loads(row["fallacies_json"] or "[]")),
        "turns": len([m for m in json.loads(row["transcript_json"] or "[]") if m.get("role") == "user"]),
    }
    if full:
        out["transcript"] = json.loads(row["transcript_json"] or "[]")
        out["fallacies"] = json.loads(row["fallacies_json"] or "[]")
        out["strengths"] = json.loads(row["strengths_json"] or "[]")
        try:
            out["scorecard"] = json.loads(row.get("scorecard_json") or "null")
        except (TypeError, ValueError):
            out["scorecard"] = None
    return out


def _outcome(score_you: int, score_nemesis: int) -> str:
    margin = int(score_you) - int(score_nemesis)
    return "win" if margin >= 4 else "loss" if margin <= -4 else "draw"


# --------------------------------------------------------------------------
# Users (authentication)
# --------------------------------------------------------------------------
def _row_to_user(row: dict | None) -> dict | None:
    if not row:
        return None
    return {
        "id": int(row["id"]), "email": row["email"], "display_name": row["display_name"],
        "password_hash": row["password_hash"], "created_at": row["created_at"],
        "last_login_at": row.get("last_login_at"),
    }


def create_user(email: str, display_name: str, password_hash: str) -> int:
    init_db()
    with connection() as cur:
        sql = "INSERT INTO users (email, display_name, password_hash, created_at) VALUES (?, ?, ?, ?)"
        params = (email, display_name, password_hash, _now())
        if IS_POSTGRES:
            cur.execute(sql + " RETURNING id", params)
            return int(cur.fetchone()["id"])
        cur.execute(sql, params)
        return int(cur.lastrowid)


def get_user_by_email(email: str) -> dict | None:
    init_db()
    with connection() as cur:
        return _row_to_user(cur.execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone())


def get_user_by_id(user_id: int) -> dict | None:
    init_db()
    with connection() as cur:
        return _row_to_user(cur.execute("SELECT * FROM users WHERE id = ?", (int(user_id),)).fetchone())


def touch_login(user_id: int) -> None:
    init_db()
    with connection() as cur:
        cur.execute("UPDATE users SET last_login_at = ? WHERE id = ?", (_now(), int(user_id)))


def update_user_password(user_id: int, password_hash: str) -> None:
    init_db()
    with connection() as cur:
        cur.execute("UPDATE users SET password_hash = ? WHERE id = ?", (password_hash, int(user_id)))


def update_user_name(user_id: int, display_name: str) -> None:
    init_db()
    with connection() as cur:
        cur.execute("UPDATE users SET display_name = ? WHERE id = ?", (display_name, int(user_id)))


def count_users() -> int:
    init_db()
    with connection() as cur:
        row = cur.execute("SELECT COUNT(*) AS n FROM users").fetchone()
    return int(row["n"]) if row else 0


# --------------------------------------------------------------------------
# Sessions
# --------------------------------------------------------------------------
def save_session(
    user_id: str | int,
    topic: str,
    transcript: list,
    fallacies: list,
    score_you: int,
    score_nemesis: int,
    scorecard_text: str,
    persona: str = "ultron",
    difficulty: str = "adept",
    language: str = "en",
    duration_s: int = 0,
    strengths: list | None = None,
    scorecard: dict | None = None,
) -> int:
    init_db()
    with connection() as cur:
        sql = (
            "INSERT INTO sessions (user_id, created_at, topic, persona, difficulty, language, duration_s, "
            "transcript_json, fallacies_json, strengths_json, score_you, score_nemesis, scorecard_text, scorecard_json) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
        )
        params = (
            user_id,
            _now(),
            topic[:200],
            persona,
            difficulty,
            language,
            int(duration_s or 0),
            json.dumps(transcript),
            json.dumps(fallacies),
            json.dumps(strengths or []),
            int(score_you),
            int(score_nemesis),
            scorecard_text[:2000],
            json.dumps(scorecard) if scorecard else None,
        )
        if IS_POSTGRES:
            cur.execute(sql + " RETURNING id", params)
            return int(cur.fetchone()["id"])
        cur.execute(sql, params)
        return int(cur.lastrowid)


def get_sessions(user_id: str, limit: int = 50) -> list[dict]:
    init_db()
    with connection() as cur:
        rows = cur.execute(
            "SELECT * FROM sessions WHERE user_id = ? ORDER BY id DESC LIMIT ?", (user_id, limit)
        ).fetchall()
    return [_row_to_session(r, full=False) for r in rows]


def get_session(user_id: str, session_id: int) -> dict | None:
    init_db()
    with connection() as cur:
        row = cur.execute(
            "SELECT * FROM sessions WHERE user_id = ? AND id = ?", (user_id, session_id)
        ).fetchone()
    return _row_to_session(row, full=True) if row else None


def delete_session(user_id: str, session_id: int) -> bool:
    init_db()
    with connection() as cur:
        cur.execute("DELETE FROM sessions WHERE user_id = ? AND id = ?", (user_id, session_id))
        return True


# --------------------------------------------------------------------------
# Stats & achievements
# --------------------------------------------------------------------------
def get_stats(user_id: str) -> dict:
    init_db()
    with connection() as cur:
        rows = cur.execute(
            "SELECT created_at, score_you, score_nemesis, fallacies_json, transcript_json, duration_s, persona "
            "FROM sessions WHERE user_id = ? ORDER BY id ASC",
            (user_id,),
        ).fetchall()

    total = len(rows)
    if not total:
        return {
            "total_debates": 0,
            "wins": 0,
            "losses": 0,
            "draws": 0,
            "avg_score": 0,
            "best_score": 0,
            "most_common_fallacy": None,
            "fallacy_totals": {},
            "longest_debate_turns": 0,
            "longest_debate_s": 0,
            "current_streak": 0,
            "best_streak": 0,
            "day_streak": 0,
            "persona_counts": {},
            "recent_scores": [],
        }

    fallacy_totals: dict[str, int] = {}
    persona_counts: dict[str, int] = {}
    wins = losses = draws = 0
    scores = []
    longest_turns = 0
    longest_s = 0
    cur_streak = best_streak = 0
    days = set()

    for r in rows:
        sy, sn = r["score_you"] or 0, r["score_nemesis"] or 0
        scores.append(sy)
        outcome = _outcome(sy, sn)
        won = outcome == "win"
        wins += int(won)
        losses += int(outcome == "loss")
        draws += int(outcome == "draw")
        cur_streak = cur_streak + 1 if won else 0
        best_streak = max(best_streak, cur_streak)
        for f in json.loads(r["fallacies_json"] or "[]"):
            name = str(f.get("name", "Unknown")).strip().title()
            fallacy_totals[name] = fallacy_totals.get(name, 0) + 1
        persona = r.get("persona") or "ultron"
        persona_counts[persona] = persona_counts.get(persona, 0) + 1
        turns = len([m for m in json.loads(r["transcript_json"] or "[]") if m.get("role") == "user"])
        longest_turns = max(longest_turns, turns)
        longest_s = max(longest_s, r.get("duration_s") or 0)
        days.add((r["created_at"] or "")[:10])

    # consecutive-day streak ending today or yesterday
    day_streak = 0
    if days:
        from datetime import date, timedelta

        today = date.today()
        d = today
        if d.isoformat() not in days:
            d = today - timedelta(days=1)
        while d.isoformat() in days:
            day_streak += 1
            d -= timedelta(days=1)

    most_common = max(fallacy_totals.items(), key=lambda kv: kv[1])[0] if fallacy_totals else None
    return {
        "total_debates": total,
        "wins": wins,
        "losses": losses,
        "draws": draws,
        "avg_score": round(sum(scores) / total, 1),
        "best_score": max(scores),
        "most_common_fallacy": most_common,
        "fallacy_totals": dict(sorted(fallacy_totals.items(), key=lambda kv: -kv[1])),
        "longest_debate_turns": longest_turns,
        "longest_debate_s": longest_s,
        "current_streak": cur_streak,
        "best_streak": best_streak,
        "day_streak": day_streak,
        "persona_counts": persona_counts,
        "recent_scores": scores[-10:],
    }


def get_achievements(user_id: str) -> list[dict]:
    init_db()
    with connection() as cur:
        rows = cur.execute(
            "SELECT key, unlocked_at, session_id FROM achievements WHERE user_id = ? ORDER BY id ASC",
            (user_id,),
        ).fetchall()
    return [dict(r) for r in rows]


def unlock_achievements(user_id: str, keys: Iterable[str], session_id: int | None) -> list[str]:
    """Insert any not-yet-unlocked achievements. Returns the newly unlocked keys."""
    init_db()
    new: list[str] = []
    with connection() as cur:
        existing = {
            r["key"] for r in cur.execute("SELECT key FROM achievements WHERE user_id = ?", (user_id,)).fetchall()
        }
        for key in keys:
            if key in existing:
                continue
            cur.execute(
                "INSERT INTO achievements (user_id, key, unlocked_at, session_id) VALUES (?, ?, ?, ?)",
                (user_id, key, _now(), session_id),
            )
            new.append(key)
    return new


# --------------------------------------------------------------------------
# Settings
# --------------------------------------------------------------------------
def get_settings(user_id: str) -> dict:
    init_db()
    with connection() as cur:
        row = cur.execute("SELECT settings_json FROM user_settings WHERE user_id = ?", (user_id,)).fetchone()
    return json.loads(row["settings_json"]) if row else {}


def save_settings(user_id: str, settings: dict) -> None:
    init_db()
    payload = json.dumps(settings)[:8000]
    with connection() as cur:
        if IS_POSTGRES:
            cur.execute(
                "INSERT INTO user_settings (user_id, settings_json, updated_at) VALUES (?, ?, ?) "
                "ON CONFLICT (user_id) DO UPDATE SET settings_json = EXCLUDED.settings_json, "
                "updated_at = EXCLUDED.updated_at",
                (user_id, payload, _now()),
            )
        else:
            cur.execute(
                "INSERT OR REPLACE INTO user_settings (user_id, settings_json, updated_at) VALUES (?, ?, ?)",
                (user_id, payload, _now()),
            )


# --------------------------------------------------------------------------
# Event log (admin panel) — never store user content, only metadata.
# --------------------------------------------------------------------------
def log_event(level: str, kind: str, request_id: str | None, model: str | None, latency_ms: int | None, message: str):
    try:
        init_db()
        with connection() as cur:
            cur.execute(
                "INSERT INTO event_log (created_at, level, kind, request_id, model, latency_ms, message) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                (_now(), level, kind, request_id, model, latency_ms, message[:500]),
            )
            # keep the table bounded
            cur.execute(
                "DELETE FROM event_log WHERE id NOT IN (SELECT id FROM event_log ORDER BY id DESC LIMIT 500)"
            )
    except Exception:  # logging must never break a request
        pass


def recent_events(limit: int = 100) -> list[dict]:
    init_db()
    with connection() as cur:
        rows = cur.execute("SELECT * FROM event_log ORDER BY id DESC LIMIT ?", (limit,)).fetchall()
    return [dict(r) for r in rows]


def latency_summary() -> dict:
    init_db()
    with connection() as cur:
        rows = cur.execute(
            "SELECT kind, latency_ms FROM event_log WHERE latency_ms IS NOT NULL ORDER BY id DESC LIMIT 300"
        ).fetchall()
    buckets: dict[str, list[int]] = {}
    for r in rows:
        buckets.setdefault(r["kind"], []).append(int(r["latency_ms"]))
    out = {}
    for kind, vals in buckets.items():
        vals.sort()
        out[kind] = {
            "count": len(vals),
            "avg_ms": round(sum(vals) / len(vals)),
            "p50_ms": vals[len(vals) // 2],
            "p95_ms": vals[min(len(vals) - 1, int(len(vals) * 0.95))],
        }
    return out


def ping() -> bool:
    with connection() as cur:
        cur.execute("SELECT 1")
    return True
