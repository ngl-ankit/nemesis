"""Shared pytest fixtures — runs the app against a throwaway SQLite file with the LLM mocked."""
import os
import sys
import tempfile

os.environ["NEMESIS_TESTING"] = "1"
os.environ["FLASK_ENV"] = "development"
os.environ.pop("DATABASE_URL", None)
os.environ["DATABASE_PATH"] = os.path.join(tempfile.mkdtemp(), "test.db")
os.environ["GROQ_API_KEY"] = "test-key"
os.environ["ADMIN_ENABLED"] = "true"
os.environ["ADMIN_TOKEN"] = "secret-admin"

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pytest  # noqa: E402

import app as app_module  # noqa: E402
import llm_client  # noqa: E402


@pytest.fixture()
def client(monkeypatch):
    monkeypatch.setattr(app_module, "counter_argument", lambda *a, **k: "Your premise collapses under scrutiny.")
    monkeypatch.setattr(app_module, "detect_fallacy", lambda s: {"fallacy_name": "Hasty Generalization", "explanation": "One case."})
    monkeypatch.setattr(app_module, "argument_strength", lambda s: {"strength": 72, "label": "Solid"})
    monkeypatch.setattr(
        app_module,
        "scorecard",
        lambda t: {"score_you": 55, "score_nemesis": 45, "strengths": ["clear"], "weaknesses": ["short"], "summary": "Close."},
    )
    monkeypatch.setattr(app_module, "stream_counter_argument", lambda *a, **k: iter(["Recal", "ibrating", "..."]))
    app_module.app.config["TESTING"] = True
    with app_module.app.test_client() as c:
        yield c


@pytest.fixture()
def llm():
    return llm_client
