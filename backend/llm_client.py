"""LLM client for Nemesis — talks to ``openai/gpt-oss-20b`` over an
OpenAI-compatible chat-completions endpoint (Groq by default).

* One model everywhere: ``config.LLM_MODEL`` (default ``openai/gpt-oss-20b``).
* Retry with exponential backoff + jitter on transient errors.
* In-character fallbacks flagged with ``fallback=True`` so the UI can show an
  honest error state instead of pretending the model answered.
* Streaming generator for the SSE debate endpoint.
* AUTO language mode: the model appends ``(lang:xx)``; ``split_lang_tag``
  strips it and returns the ISO code.
* Rubric-based evaluation: the model grades criteria 0-10, ``scoring.py``
  computes the numbers deterministically.
"""

from __future__ import annotations

import io
import json
import logging
import random
import re
import time
from typing import Iterator

import config
import scoring
from prompts import build_persona_system

log = logging.getLogger("nemesis.llm")

MODEL = config.LLM_MODEL
BASE_URL = config.LLM_BASE_URL

FALLBACK_COUNTER = "Recalibrating... state your point again."
FALLBACK_FALLACY = {"fallacy_name": "None", "explanation": "", "confidence": 0, "fallback": True}

# Reasoning models burn completion tokens on hidden chain-of-thought before
# writing visible text; give them headroom so short replies are not swallowed.
_REASONING_HEADROOM = 768


def _model_kwargs(max_tokens: int) -> dict:
    kwargs = {"model": MODEL, "max_tokens": max_tokens}
    if config.LLM_REASONING_EFFORT:
        kwargs["max_tokens"] = max_tokens + _REASONING_HEADROOM
        kwargs["reasoning_effort"] = config.LLM_REASONING_EFFORT
    return kwargs


FALLACY_PROMPT = (
    "You are a strict logic examiner. Analyse the user's debate statement for a logical "
    "fallacy (hasty generalization, false dilemma, ad hominem, slippery slope, appeal to "
    "emotion, straw man, circular reasoning, appeal to authority, red herring, anecdotal, "
    "bandwagon, tu quoque, loaded question, etc). Only flag a fallacy when it is clearly "
    "present; a merely weak or unsupported claim is NOT a fallacy. Reply ONLY with strict JSON: "
    '{"fallacy": "exact fallacy name or None", "explanation": "1-2 plain sentences or empty string", '
    '"confidence": integer 0-100}'
)

STRENGTH_PROMPT = (
    "You are a rigorous debate judge grading ONE statement made by a debater. Grade each "
    "criterion 0-10 with this calibration: 0-2 absent/incoherent, 3-4 weak / bare assertion, "
    "5-6 adequate, 7-8 strong and specific, 9-10 exceptional. A short opinion with no reasons "
    "should score 2-4 on evidence and logic. Be harsh but fair. Criteria: evidence (facts, "
    "examples, data), logic (valid reasoning, no gaps), relevance (addresses the topic or the "
    "opponent's point), clarity (precise, well-structured). Reply ONLY with strict JSON: "
    '{"evidence": int, "logic": int, "relevance": int, "clarity": int, "label": "2-4 word verdict"}'
)

SCORECARD_PROMPT = (
    "You are the head judge of a formal debate. You receive the transcript between a human "
    "debater ('You') and an AI opponent ('Nemesis'), plus fallacies detected in the human's "
    "statements. Grade BOTH sides on each criterion 0-10: 0-2 absent/incoherent, 3-4 weak, "
    "5-6 adequate, 7-8 strong, 9-10 exceptional. Typical casual debaters land at 3-6; reserve "
    "8+ for arguments backed by specific evidence, tight logic and direct rebuttals sustained "
    "across several turns. Never inflate scores for effort or politeness. Human criteria: "
    "claim_clarity, evidence, logic, rebuttal (answered Nemesis's counter-points), consistency, "
    "persuasiveness. Nemesis criteria: evidence, logic, rebuttal, persuasiveness. Also list 2-3 "
    "concrete strengths and 2-3 concrete weaknesses of the human (reference specific moments) "
    "and a 1-2 sentence verdict naming who argued better and why. Reply ONLY with strict JSON: "
    '{"you": {"claim_clarity": int, "evidence": int, "logic": int, "rebuttal": int, "consistency": int, '
    '"persuasiveness": int}, "nemesis": {"evidence": int, "logic": int, "rebuttal": int, "persuasiveness": int}, '
    '"strengths": [strings], "weaknesses": [strings], "summary": "string"}'
)

LANG_TAG_RE = re.compile(r"\(\s*lang\s*:\s*([A-Za-z]{2})\s*\)\s*[.。！!．]*\s*$")

_MIME_EXT = {
    "audio/webm": "webm",
    "audio/ogg": "ogg",
    "audio/mp4": "m4a",
    "audio/mpeg": "mp3",
    "audio/mp3": "mp3",
    "audio/wav": "wav",
    "audio/x-wav": "wav",
    "audio/aac": "aac",
}


def split_lang_tag(text: str) -> tuple[str, str | None]:
    if not text:
        return "", None
    stripped = text.strip()
    match = LANG_TAG_RE.search(stripped)
    if match:
        return stripped[: match.start()].rstrip(), match.group(1).lower()
    return stripped, None


def transcribe_audio(audio_bytes: bytes, mime_type: str = "audio/webm", language: str | None = None) -> tuple[str, bool]:
    """Return ``(text, fallback)`` from the provider STT endpoint."""
    if not audio_bytes:
        return "", True

    mime = (mime_type or "audio/webm").split(";", 1)[0].strip().lower()
    ext = _MIME_EXT.get(mime, "webm")
    payload = io.BytesIO(audio_bytes)
    payload.name = f"clip.{ext}"

    kwargs = {
        "model": config.STT_MODEL,
        "file": (payload.name, payload, mime),
        "temperature": 0,
    }
    if language and language not in {"", "auto"}:
        kwargs["language"] = str(language)[:12]

    def call():
        resp = _get_client().audio.transcriptions.create(**kwargs)
        text = getattr(resp, "text", "") if resp is not None else ""
        return str(text or "").strip()

    try:
        text = _with_retries(call, op="transcribe")
    except LLMUnavailable:
        return "", True
    return (text, False) if text else ("", True)


_client = None


class LLMUnavailable(RuntimeError):
    """Raised after all retries are exhausted."""


def is_configured() -> bool:
    return bool(config.LLM_API_KEY)


def _get_client():
    global _client
    if _client is None:
        if not config.LLM_API_KEY:
            raise LLMUnavailable("No LLM API key found. Set LLM_API_KEY in the environment.")
        from openai import OpenAI

        _client = OpenAI(api_key=config.LLM_API_KEY, base_url=BASE_URL, timeout=config.LLM_TIMEOUT_S, max_retries=0)
    return _client


def _is_retryable(exc: Exception) -> bool:
    if exc.__class__.__name__ in {"RateLimitError", "APITimeoutError", "APIConnectionError", "InternalServerError"}:
        return True
    return getattr(exc, "status_code", None) in {408, 409, 425, 429, 500, 502, 503, 504}


def _with_retries(fn, *, op: str):
    attempts = max(1, config.LLM_MAX_RETRIES)
    delay = 0.6
    last: Exception | None = None
    for attempt in range(1, attempts + 1):
        try:
            return fn()
        except LLMUnavailable:
            raise
        except Exception as exc:  # noqa: BLE001
            last = exc
            retryable = _is_retryable(exc)
            log.warning("llm_call_failed op=%s attempt=%d/%d retryable=%s error=%s detail=%s",
                        op, attempt, attempts, retryable, exc.__class__.__name__, str(exc)[:200])
            if not retryable or attempt == attempts:
                break
            time.sleep(delay + random.uniform(0, delay / 2))
            delay = min(delay * 2, 6.0)
    raise LLMUnavailable(f"{op} failed after {attempts} attempt(s): {last.__class__.__name__}") from last


def _chat(system: str, user: str, max_tokens: int, temperature: float = 0.7, *, op: str) -> str:
    def call():
        response = _get_client().chat.completions.create(
            messages=[{"role": "system", "content": system}, {"role": "user", "content": user}],
            temperature=temperature, **_model_kwargs(max_tokens),
        )
        return (response.choices[0].message.content or "").strip()

    return _with_retries(call, op=op)


def _build_messages(opinion, persona, history, difficulty, aggression, language):
    system, diff = build_persona_system(persona, difficulty, int(aggression or 50), language)
    messages = [{"role": "system", "content": system}]
    for item in history or []:
        if isinstance(item, dict):
            role, text = item.get("role"), item.get("text") or item.get("content")
        else:
            role, text = item[0], item[1]
        if role in {"user", "assistant"} and text:
            messages.append({"role": role, "content": str(text)[:1500]})
    messages.append({"role": "user", "content": opinion})
    return messages, diff


def counter_argument(opinion, persona, history, difficulty="adept", aggression=50, language="en") -> tuple[str, bool]:
    """Return ``(reply, fallback)`` — non-streaming persona reply."""
    messages, diff = _build_messages(opinion, persona, history, difficulty, aggression, language)

    def call():
        response = _get_client().chat.completions.create(
            messages=messages, temperature=diff["temperature"], **_model_kwargs(diff["max_tokens"]))
        return (response.choices[0].message.content or "").strip()

    try:
        text = _with_retries(call, op="debate")
    except LLMUnavailable:
        return FALLBACK_COUNTER, True
    return (text, False) if text else (FALLBACK_COUNTER, True)


def stream_counter_argument(opinion, persona, history, difficulty="adept", aggression=50, language="en") -> Iterator[tuple[str, bool]]:
    """Yield ``(text_delta, fallback)`` tuples as they arrive."""
    messages, diff = _build_messages(opinion, persona, history, difficulty, aggression, language)

    def open_stream():
        return _get_client().chat.completions.create(
            messages=messages, temperature=diff["temperature"], stream=True, **_model_kwargs(diff["max_tokens"]))

    try:
        stream = _with_retries(open_stream, op="debate_stream")
    except LLMUnavailable:
        yield FALLBACK_COUNTER, True
        return
    produced = False
    try:
        for chunk in stream:
            if not chunk.choices:
                continue
            text = getattr(chunk.choices[0].delta, "content", None)
            if text:
                produced = True
                yield text, False
    except Exception as exc:  # noqa: BLE001
        log.warning("llm_stream_interrupted error=%s", exc.__class__.__name__)
        yield ("" if not produced else " ") + FALLBACK_COUNTER, True
        return
    if not produced:
        yield FALLBACK_COUNTER, True


def _extract_json(text):
    if not text:
        return {}
    cleaned = re.sub(r"^```(?:json)?\s*|\s*```$", "", text.strip(), flags=re.IGNORECASE | re.MULTILINE)
    match = re.search(r"\{.*\}", cleaned, re.DOTALL)
    for candidate in (cleaned, match.group(0) if match else None):
        if not candidate:
            continue
        try:
            data = json.loads(candidate)
            if isinstance(data, dict):
                return data
        except (json.JSONDecodeError, ValueError):
            continue
    return {}


def detect_fallacy(statement) -> dict:
    try:
        raw = _chat(FALLACY_PROMPT, statement, max_tokens=160, temperature=0.1, op="fallacy")
    except LLMUnavailable:
        return dict(FALLBACK_FALLACY)
    data = _extract_json(raw)
    if not data:
        return dict(FALLBACK_FALLACY)
    name = str(data.get("fallacy") or "None").strip()
    confidence = scoring.clamp_int(data.get("confidence"), default=60)
    if name.lower() in {"", "none", "null", "no fallacy", "n/a", "no", "false"} or confidence < 50:
        name = "None"
    return {
        "fallacy_name": name,
        "explanation": str(data.get("explanation") or "").strip() if name != "None" else "",
        "confidence": confidence,
        "fallback": False,
    }


def argument_strength(statement) -> dict:
    try:
        raw = _chat(STRENGTH_PROMPT, statement, max_tokens=120, temperature=0.1, op="strength")
    except LLMUnavailable:
        return {"strength": None, "label": "Signal lost", "rubric": {}, "fallback": True}
    data = _extract_json(raw)
    if not data:
        return {"strength": None, "label": "Unreadable", "rubric": {}, "fallback": True}
    result = scoring.strength_from_rubric(data, statement)
    result["label"] = str(data.get("label") or "Assessed")[:40]
    result["fallback"] = False
    return result


def scorecard(transcript: str, *, fallacies: list, strengths: list, turns: int, user_words: int) -> dict:
    note = "Fallacies detected in the human's statements: " + (", ".join(str(f) for f in fallacies) if fallacies else "none")
    try:
        data = _extract_json(_chat(SCORECARD_PROMPT, f"{note}\n\nTRANSCRIPT:\n{transcript}", max_tokens=520, temperature=0.2, op="scorecard"))
    except LLMUnavailable:
        data = {}
    return scoring.compute_scorecard(data, fallacies=fallacies, strengths=strengths, turns=turns, user_words=user_words)
