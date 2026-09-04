"""Unit tests for JSON extraction, retry/backoff and fallbacks in llm_client."""
import pytest


@pytest.mark.parametrize(
    "raw,expected",
    [
        ('{"fallacy": "Ad Hominem", "explanation": "x"}', {"fallacy": "Ad Hominem", "explanation": "x"}),
        ('Sure! Here you go:\n{"fallacy": "None", "explanation": ""}\nHope this helps.', {"fallacy": "None", "explanation": ""}),
        ('```json\n{"score_you": 60, "score_nemesis": 40}\n```', {"score_you": 60, "score_nemesis": 40}),
        ("not json at all", {}),
        ("", {}),
        (None, {}),
        ("[1,2,3]", {}),
        ('{"a": {"nested": true}} trailing', {"a": {"nested": True}}),
    ],
)
def test_extract_json(llm, raw, expected):
    assert llm._extract_json(raw) == expected


def test_to_int_clamps(llm):
    assert llm._to_int("87") == 87
    assert llm._to_int(150) == 100
    assert llm._to_int(-5) == 0
    assert llm._to_int("abc", default=42) == 42
    assert llm._to_int(63.7) == 63


def test_detect_fallacy_normalises_none(llm, monkeypatch):
    monkeypatch.setattr(llm, "_chat", lambda *a, **k: '{"fallacy": "no fallacy", "explanation": ""}')
    assert llm.detect_fallacy("x") == {"fallacy_name": "None", "explanation": ""}
    monkeypatch.setattr(llm, "_chat", lambda *a, **k: '{"fallacy": "Straw Man", "explanation": "Misrepresented."}')
    assert llm.detect_fallacy("x")["fallacy_name"] == "Straw Man"


def test_scorecard_forces_sum_100(llm, monkeypatch):
    monkeypatch.setattr(llm, "_chat", lambda *a, **k: '{"score_you": 70, "score_nemesis": 70, "strengths": ["a"], "weaknesses": [], "summary": "s"}')
    out = llm.scorecard("t")
    assert out["score_you"] == 70 and out["score_nemesis"] == 30


def test_scorecard_fallback_on_garbage(llm, monkeypatch):
    monkeypatch.setattr(llm, "_chat", lambda *a, **k: "???")
    assert llm.scorecard("t") == llm.FALLBACK_SCORECARD


class _Boom(Exception):
    status_code = 503


def test_with_retries_backs_off_then_raises(llm, monkeypatch):
    sleeps = []
    monkeypatch.setattr(llm.time, "sleep", lambda s: sleeps.append(s))
    monkeypatch.setattr(llm.config, "LLM_MAX_RETRIES", 3)
    calls = {"n": 0}

    def fn():
        calls["n"] += 1
        raise _Boom("down")

    with pytest.raises(llm.LLMUnavailable):
        llm._with_retries(fn, op="t")
    assert calls["n"] == 3
    assert len(sleeps) == 2
    assert sleeps[1] > sleeps[0]  # exponential growth


def test_with_retries_recovers(llm, monkeypatch):
    monkeypatch.setattr(llm.time, "sleep", lambda s: None)
    state = {"n": 0}

    def fn():
        state["n"] += 1
        if state["n"] < 2:
            raise _Boom()
        return "ok"

    assert llm._with_retries(fn, op="t") == "ok"


def test_non_retryable_fails_fast(llm, monkeypatch):
    monkeypatch.setattr(llm.time, "sleep", lambda s: pytest.fail("should not sleep"))

    class Bad(Exception):
        status_code = 400

    def fn():
        raise Bad()

    with pytest.raises(llm.LLMUnavailable):
        llm._with_retries(fn, op="t")


def test_counter_argument_fallback(llm, monkeypatch):
    monkeypatch.setattr(llm, "_with_retries", lambda fn, op: (_ for _ in ()).throw(llm.LLMUnavailable("x")))
    assert llm.counter_argument("x", "ultron", []) == llm.FALLBACK_COUNTER


def test_stream_fallback_when_unavailable(llm, monkeypatch):
    monkeypatch.setattr(llm, "_with_retries", lambda fn, op: (_ for _ in ()).throw(llm.LLMUnavailable("x")))
    assert list(llm.stream_counter_argument("x", "ultron", [])) == [llm.FALLBACK_COUNTER]


def test_stream_yields_deltas(llm, monkeypatch):
    class Delta:
        def __init__(self, c):
            self.content = c

    class Choice:
        def __init__(self, c):
            self.delta = Delta(c)

    class Chunk:
        def __init__(self, c):
            self.choices = [Choice(c)]

    monkeypatch.setattr(llm, "_with_retries", lambda fn, op: iter([Chunk("Hel"), Chunk("lo"), Chunk(None)]))
    assert list(llm.stream_counter_argument("x", "ultron", [("user", "a"), {"role": "assistant", "text": "b"}])) == ["Hel", "lo"]


def test_build_messages_handles_both_history_shapes(llm):
    msgs, diff = llm._build_messages("opinion", "economist", [["user", "a"], {"role": "assistant", "text": "b"}, ["system", "ignored"]], "novice", 90, "es")
    assert [m["role"] for m in msgs] == ["system", "user", "assistant", "user"]
    assert "Spanish" in msgs[0]["content"]
    assert "NOVICE" in msgs[0]["content"]
    assert "maximally confrontational" in msgs[0]["content"]
    assert diff["max_tokens"] == 90
