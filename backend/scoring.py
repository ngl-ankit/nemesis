"""Deterministic scoring for Nemesis.

The model (``openai/gpt-oss-20b``) only grades individual rubric criteria on a
0-10 scale. Every number the user sees — per-turn strength, final 0-100
scores, penalties, caps and the winner — is computed here so results are
consistent, auditable and sensitive to actual performance:

* Weighted rubric → base score (no "everyone gets 70").
* Fallacy penalty: each detected fallacy costs points.
* Depth caps: a one-line debate cannot demonstrate rebuttal or consistency,
  so very short sessions are capped regardless of judge confidence.
* Per-turn telemetry (the live strength gauge) is blended into the final score
  so the scorecard agrees with what the HUD showed during the debate.
* Both sides are scored independently — they no longer have to sum to 100,
  which previously inflated the human whenever Nemesis was weak.
"""

from __future__ import annotations

from typing import Any

STRENGTH_WEIGHTS = {"evidence": 0.30, "logic": 0.30, "relevance": 0.20, "clarity": 0.20}
YOU_WEIGHTS = {
    "claim_clarity": 0.10, "evidence": 0.25, "logic": 0.25,
    "rebuttal": 0.20, "consistency": 0.10, "persuasiveness": 0.10,
}
NEMESIS_WEIGHTS = {"evidence": 0.30, "logic": 0.30, "rebuttal": 0.20, "persuasiveness": 0.20}

FALLACY_PENALTY = 7
FALLACY_PENALTY_CAP = 35
TURN_CAPS = {1: 58, 2: 72, 3: 84}            # max human score by number of human turns
WORD_CAPS = ((8, 30), (15, 45), (30, 60))    # (max words, cap) for single statements


def clamp_int(value: Any, default: int = 0, lo: int = 0, hi: int = 100) -> int:
    try:
        return max(lo, min(hi, int(round(float(value)))))
    except (TypeError, ValueError):
        return default


def _grade(value: Any, default: int = 4) -> int:
    """Normalise a rubric grade to 0-10 (accepts 0-10 or accidental 0-100)."""
    try:
        v = float(value)
    except (TypeError, ValueError):
        return default
    if v > 10:
        v = v / 10.0
    return max(0, min(10, int(round(v))))


def _weighted(rubric: dict, weights: dict) -> tuple[int, dict]:
    graded = {k: _grade(rubric.get(k)) for k in weights}
    return int(round(sum(graded[k] * w for k, w in weights.items()) * 10.0)), graded


def word_count(text: str) -> int:
    return len([w for w in str(text or "").split() if w.strip()])


def strength_from_rubric(data: dict, statement: str) -> dict:
    """Combine 0-10 criterion grades into a 0-100 strength with a length cap."""
    score, graded = _weighted(data, STRENGTH_WEIGHTS)
    words = word_count(statement)
    cap = 100
    for max_words, word_cap in WORD_CAPS:
        if words <= max_words:
            cap = word_cap
            break
    return {"strength": min(score, cap), "rubric": graded, "raw": score, "cap": cap, "words": words}


def grade_letter(score: int) -> str:
    for threshold, letter in ((85, "S"), (75, "A"), (62, "B"), (48, "C"), (32, "D")):
        if score >= threshold:
            return letter
    return "F"


def outcome(score_you: int, score_nemesis: int) -> str:
    margin = int(score_you) - int(score_nemesis)
    return "win" if margin >= 4 else "loss" if margin <= -4 else "draw"


def _fallback_summary(score_you: int, score_nemesis: int) -> str:
    lead = {
        "win": "you edged the exchange",
        "loss": "Nemesis held the stronger line this round",
        "draw": "an even exchange",
    }[outcome(score_you, score_nemesis)]
    return f"Provisional verdict from live telemetry: {lead}. The judge was offline, so no detailed critique is available."


def compute_scorecard(data: dict, *, fallacies: list, strengths: list, turns: int, user_words: int) -> dict:
    """Turn judge rubric output + session telemetry into the final verdict."""
    strengths = [clamp_int(s) for s in strengths if isinstance(s, (int, float))]
    avg_strength = int(round(sum(strengths) / len(strengths))) if strengths else None
    fallacy_count = len(fallacies or [])
    penalty = min(FALLACY_PENALTY_CAP, FALLACY_PENALTY * fallacy_count)
    depth_cap = TURN_CAPS.get(max(1, turns), 100)
    judge_ok = isinstance(data, dict) and isinstance(data.get("you"), dict)

    if judge_ok:
        rubric_you, graded_you = _weighted(data["you"], YOU_WEIGHTS)
        rubric_nem, graded_nem = _weighted(data.get("nemesis") or {}, NEMESIS_WEIGHTS)
        blended = rubric_you if avg_strength is None else int(round(0.7 * rubric_you + 0.3 * avg_strength))
    else:
        graded_you, graded_nem = {}, {}
        rubric_you = avg_strength if avg_strength is not None else 40
        rubric_nem = 62  # a well-prepared opponent: solid, not perfect
        blended = rubric_you

    words_cap = 100
    if turns <= 1:
        for max_words, word_cap in WORD_CAPS:
            if user_words <= max_words:
                words_cap = word_cap + 10
                break

    score_you = max(0, min(blended - penalty, depth_cap, words_cap))
    score_nemesis = clamp_int(rubric_nem)

    strengths_list = data.get("strengths") if judge_ok else None
    weaknesses_list = data.get("weaknesses") if judge_ok else None
    strengths_list = list(strengths_list) if isinstance(strengths_list, list) else []
    weaknesses_list = list(weaknesses_list) if isinstance(weaknesses_list, list) else []
    if fallacy_count and judge_ok and not any("fallac" in str(w).lower() for w in weaknesses_list):
        weaknesses_list.append(
            f"{fallacy_count} logical fallac{'y' if fallacy_count == 1 else 'ies'} detected — each one cost you points."
        )
    summary = str(data.get("summary") or "").strip() if judge_ok else ""
    if not summary:
        summary = _fallback_summary(score_you, score_nemesis)

    return {
        "score_you": score_you,
        "score_nemesis": score_nemesis,
        "outcome": outcome(score_you, score_nemesis),
        "grade": grade_letter(score_you),
        "strengths": [str(s)[:240] for s in strengths_list][:4],
        "weaknesses": [str(w)[:240] for w in weaknesses_list][:4],
        "summary": summary[:600],
        "breakdown": {
            "you": graded_you,
            "nemesis": graded_nem,
            "judge_score": rubric_you,
            "telemetry_avg": avg_strength,
            "fallacy_penalty": penalty,
            "fallacy_count": fallacy_count,
            "depth_cap": depth_cap,
            "turns": turns,
        },
        "fallback": not judge_ok,
    }
