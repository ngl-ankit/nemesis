"""SQLite persistence for Nemesis debate sessions."""

import json
import sqlite3
from datetime import datetime

DB_PATH = "nemesis.db"

SCHEMA = """
CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    topic TEXT,
    transcript_json TEXT,
    fallacies_json TEXT,
    score_you INTEGER,
    score_nemesis INTEGER,
    scorecard_text TEXT
);
"""


def _connect():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    """Create tables on first run."""
    conn = _connect()
    conn.execute(SCHEMA)
    conn.commit()
    conn.close()


def save_session(topic, transcript, fallacies, score_you, score_nemesis, scorecard_text):
    init_db()
    conn = _connect()
    conn.execute(
        "INSERT INTO sessions "
        "(created_at, topic, transcript_json, fallacies_json, score_you, score_nemesis, scorecard_text) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        (
            datetime.now().isoformat(),
            topic,
            json.dumps(transcript),
            json.dumps(fallacies),
            score_you,
            score_nemesis,
            scorecard_text,
        ),
    )
    conn.commit()
    conn.close()


def get_sessions():
    """Return all past sessions, newest first."""
    init_db()
    conn = _connect()
    rows = conn.execute("SELECT * FROM sessions ORDER BY id DESC").fetchall()
    conn.close()
    return [
        {
            "id": row["id"],
            "created_at": row["created_at"],
            "topic": row["topic"],
            "transcript": json.loads(row["transcript_json"] or "[]"),
            "fallacies": json.loads(row["fallacies_json"] or "[]"),
            "score_you": row["score_you"],
            "score_nemesis": row["score_nemesis"],
            "scorecard_text": row["scorecard_text"],
        }
        for row in rows
    ]