"""API, authentication and scoring tests. Run: cd backend && python -m pytest -q"""
import os
import sys

os.environ["NEMESIS_TESTING"] = "1"
os.environ["DATABASE_PATH"] = os.path.join(os.path.dirname(__file__), "_test.db")
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pytest  # noqa: E402

import app as nemesis  # noqa: E402
import scoring  # noqa: E402


@pytest.fixture()
def client():
    yield nemesis.app.test_client()


@pytest.fixture(scope="session", autouse=True)
def _cleanup():
    yield
    for suffix in ("", "-wal", "-shm"):
        try:
            os.remove(os.environ["DATABASE_PATH"] + suffix)
        except OSError:
            pass


def test_health_reports_gpt_oss_20b(client):
    j = client.get("/health").json
    assert j["status"] == "ok" and j["db_ok"] is True
    assert j["model"] == "openai/gpt-oss-20b"


def test_protected_routes_require_auth(client):
    for path in ("/api/stats", "/api/settings", "/api/session/history", "/api/achievements"):
        assert client.get(path).status_code == 401
    assert client.post("/api/debate", json={"opinion": "x"}).status_code == 401


def test_register_login_logout_persistence(client):
    r = client.post("/api/auth/register", json={"email": "Op@Example.com", "password": "password123", "display_name": "Op"})
    assert r.status_code == 201 and r.json["user"]["email"] == "op@example.com"
    assert client.post("/api/auth/register", json={"email": "op@example.com", "password": "password123"}).status_code == 409
    assert client.post("/api/auth/register", json={"email": "bad", "password": "password123"}).status_code == 400
    assert client.post("/api/auth/register", json={"email": "x@y.io", "password": "short"}).status_code == 400

    assert client.post("/api/settings", json={"persona": "thanos", "language": "hi"}).json["settings"]["persona"] == "thanos"
    save = client.post("/api/session/save", json={"topic": "t", "transcript": [{"role": "user", "text": "a b"}], "fallacies": [], "score_you": 40, "score_nemesis": 60, "scorecard": {"grade": "C"}})
    assert save.status_code == 200 and save.json["ok"]
    sid = save.json["id"]

    assert client.post("/api/auth/logout").json["ok"]
    assert client.get("/api/settings").status_code == 401
    assert client.post("/api/auth/login", json={"email": "op@example.com", "password": "wrongpass"}).status_code == 401
    assert client.post("/api/auth/login", json={"email": "op@example.com", "password": "password123"}).status_code == 200

    assert client.get("/api/settings").json["persona"] == "thanos"
    detail = client.get(f"/api/session/{sid}").json
    assert detail["scorecard"] == {"grade": "C"} and detail["outcome"] == "loss"
    assert client.get("/api/stats").json["total_debates"] == 1


def test_user_isolation(client):
    client.post("/api/auth/register", json={"email": "a@a.io", "password": "password123"})
    sid = client.post("/api/session/save", json={"topic": "mine", "transcript": [], "fallacies": [], "score_you": 1, "score_nemesis": 2}).json["id"]
    client.post("/api/auth/logout")
    client.post("/api/auth/register", json={"email": "b@b.io", "password": "password123"})
    assert client.get(f"/api/session/{sid}").status_code == 404
    assert client.get("/api/session/history").json["sessions"] == []


def test_scorecard_without_llm_is_provisional_and_capped(client):
    client.post("/api/auth/register", json={"email": "c@c.io", "password": "password123"})
    j = client.post("/api/scorecard", json={"turns": [{"role": "user", "text": "AI is bad"}], "fallacies": [{"name": "Bandwagon"}], "strengths": [30]}).json
    assert j["fallback"] is True and j["score_you"] <= 40 and j["outcome"] == "loss"


def test_scoring_math_is_sensitive():
    inflated = {"you": {k: 9 for k in scoring.YOU_WEIGHTS}, "nemesis": {k: 7 for k in scoring.NEMESIS_WEIGHTS}}
    one_liner = scoring.compute_scorecard(inflated, fallacies=["Straw man"], strengths=[30], turns=1, user_words=5)
    assert one_liner["score_you"] <= 40  # depth + length caps + penalty
    strong = scoring.compute_scorecard(inflated, fallacies=[], strengths=[85, 90, 88, 84], turns=4, user_words=400)
    assert strong["score_you"] >= 80 and strong["outcome"] == "win"
    weak = {"you": {k: 3 for k in scoring.YOU_WEIGHTS}, "nemesis": {k: 7 for k in scoring.NEMESIS_WEIGHTS}}
    poor = scoring.compute_scorecard(weak, fallacies=["A", "B"], strengths=[25, 30], turns=3, user_words=150)
    assert poor["score_you"] < 25 and poor["outcome"] == "loss"
    assert scoring.strength_from_rubric({"evidence": 9, "logic": 9, "relevance": 9, "clarity": 9}, "AI is bad")["strength"] == 30
