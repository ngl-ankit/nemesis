"""API route tests."""
import json


def test_index_serves_html(client):
    r = client.get("/")
    assert r.status_code == 200
    assert b"NEMESIS" in r.data


def test_health(client):
    r = client.get("/health")
    assert r.status_code == 200
    body = r.get_json()
    assert body["status"] == "ok"
    assert body["db"] == "sqlite"
    assert "X-Request-ID" in r.headers


def test_config_and_topics(client):
    assert client.get("/api/config").get_json()["personas"] == ["ultron", "economist", "ethicist", "skeptic"]
    topics = client.get("/api/topics").get_json()
    assert topics["categories"] and topics["categories"][0]["topics"]


def test_debate_requires_opinion(client):
    assert client.post("/api/debate", json={}).status_code == 400
    assert client.post("/api/debate", json={"opinion": "   "}).status_code == 400


def test_debate_returns_counter(client):
    r = client.post("/api/debate", json={"opinion": "Cats are better than dogs", "persona": "skeptic", "difficulty": "ultron"})
    assert r.status_code == 200
    assert r.get_json()["counter_argument"].startswith("Your premise")


def test_debate_stream_sse(client):
    r = client.post("/api/debate/stream", json={"opinion": "Taxes are theft"})
    assert r.status_code == 200
    assert r.headers["Content-Type"].startswith("text/event-stream")
    text = r.get_data(as_text=True)
    assert "event: meta" in text
    assert text.count("event: delta") == 3
    assert "event: done" in text
    done_line = [l for l in text.splitlines() if l.startswith("data:") and '"text"' in l][-1]
    assert json.loads(done_line[5:])["text"] == "Recalibrating..."


def test_fallacy_and_strength(client):
    assert client.post("/api/fallacy", json={"statement": "Everyone knows"}).get_json()["fallacy_name"] == "Hasty Generalization"
    assert client.post("/api/fallacy", json={"statement": ""}).get_json()["fallacy_name"] == "None"
    assert client.post("/api/strength", json={"statement": "Because data"}).get_json()["strength"] == 72


def test_scorecard(client):
    assert client.post("/api/scorecard", json={}).status_code == 400
    body = client.post("/api/scorecard", json={"transcript": "You: hi\nNemesis: no"}).get_json()
    assert body["score_you"] + body["score_nemesis"] == 100


def _save(client, **overrides):
    payload = {
        "topic": "Remote work",
        "transcript": [{"role": "user", "text": "Remote is better"}, {"role": "assistant", "text": "Wrong."}],
        "fallacies": [],
        "score_you": 60,
        "score_nemesis": 40,
        "scorecard_text": "You held.",
        "persona": "ultron",
        "difficulty": "ultron",
        "strengths": [35, 80],
    }
    payload.update(overrides)
    return client.post("/api/session/save", json=payload)


def test_session_save_history_detail_scoped(client):
    r = _save(client)
    assert r.status_code == 200
    body = r.get_json()
    keys = {a["key"] for a in body["new_achievements"]}
    assert {"first_blood", "steelman_slayer", "comeback_win"} <= keys
    sid = body["id"]

    hist = client.get("/api/session/history").get_json()["sessions"]
    assert len(hist) == 1 and hist[0]["id"] == sid and "transcript" not in hist[0]

    detail = client.get(f"/api/session/{sid}").get_json()
    assert detail["transcript"][0]["text"] == "Remote is better"
    assert detail["difficulty"] == "ultron"

    # A different user (fresh cookie jar) must not see this session.
    with client.application.test_client() as other:
        assert other.get("/api/session/history").get_json()["sessions"] == []
        assert other.get(f"/api/session/{sid}").status_code == 404

    assert client.delete(f"/api/session/{sid}").status_code == 200
    assert client.get("/api/session/history").get_json()["sessions"] == []


def test_stats_and_achievements(client):
    assert client.get("/api/stats").get_json()["total_debates"] == 0
    _save(client, fallacies=[{"name": "ad hominem"}])
    _save(client, fallacies=[{"name": "Ad Hominem"}, {"name": "slippery slope"}], score_you=30, score_nemesis=70)
    stats = client.get("/api/stats").get_json()
    assert stats["total_debates"] == 2
    assert stats["wins"] == 1
    assert stats["most_common_fallacy"] == "Ad Hominem"
    assert stats["fallacy_totals"]["Ad Hominem"] == 2
    achs = client.get("/api/achievements").get_json()["achievements"]
    assert any(a["key"] == "first_blood" and a["unlocked"] for a in achs)
    assert any(a["key"] == "veteran" and not a["unlocked"] for a in achs)


def test_settings_roundtrip_filters_unknown_keys(client):
    r = client.post("/api/settings", json={"theme": "jarvis", "wakePhrase": "hey nemesis", "evil": 1})
    assert r.get_json()["settings"] == {"theme": "jarvis", "wakePhrase": "hey nemesis"}
    assert client.get("/api/settings").get_json()["theme"] == "jarvis"


def test_admin_gated(client):
    assert client.get("/admin").status_code == 403
    assert client.get("/api/admin/diagnostics").status_code == 403
    r = client.get("/api/admin/diagnostics", headers={"X-Admin-Token": "secret-admin"})
    assert r.status_code == 200
    assert r.get_json()["model"]


def test_api_404_is_json(client):
    r = client.get("/api/nope")
    assert r.status_code == 404 and r.get_json()["error"] == "not_found"


def test_security_headers(client):
    r = client.get("/")
    assert r.headers["X-Frame-Options"] == "DENY"
    assert r.headers["X-Content-Type-Options"] == "nosniff"


def test_pwa_assets_served(client):
    r = client.get("/manifest.webmanifest")
    assert r.status_code == 200
    assert "manifest+json" in r.headers["Content-Type"]
    assert r.get_json(force=True)["short_name"] == "Nemesis"
    r = client.get("/sw.js")
    assert r.status_code == 200
    assert b"addEventListener" in r.data
    for icon in ("icon.svg", "icon-192.png", "icon-512.png", "icon-512-maskable.png"):
        assert client.get(f"/static/icons/{icon}").status_code == 200


def test_admin_page_renders_with_token(client):
    assert client.get("/admin").status_code == 403
    r = client.get("/admin", headers={"X-Admin-Token": "secret-admin"})
    assert r.status_code == 200
    assert b"ADMIN DIAGNOSTICS" in r.data
