"""Groq LLM client — OpenAI-compatible SDK pointed at Groq's API.

Features
--------
* Model configurable via ``GROQ_MODEL`` (e.g. ``llama-3.3-70b-versatile``).
* Retry with exponential backoff + jitter on transient errors.
* Graceful in-character fallbacks instead of raw errors.
* Streaming generator for the SSE debate endpoint.
* Spoken-language auto-detect: the model appends a ``(lang:xx)`` tag in AUTO
  mode; ``split_lang_tag`` strips it and returns the ISO code.
"""

from __future__ import annotations

import json
import logging
import random
import re
import time
from typing import Iterator

import config
from prompts import build_persona_system

log = logging.getLogger("nemesis.llm")

MODEL = config.GROQ_MODEL
BASE_URL = config.GROQ_BASE_URL

FALLBACK_COUNTER = "Recalibrating... state your point again."
FALLBACK_FALLACY = {"fallacy_name": "None", "explanation": ""}
FALLBACK_SCORECARD = {
    "score_you": 50,
    "score_nemesis": 50,
    "strengths": ["You showed up to the arena."],
    "weaknesses": ["Scoring systems were offline — verdict withheld."],
    "summary": "Recalibrating. The verdict could not be computed this round.",
}

# Reasoning models (openai/gpt-oss-*, o-series) burn completion tokens on hidden
# chain-of-thought before writing a single visible word. Our prompts cap replies
# at 45-120 words, so without extra headroom the whole budget vanishes into
# reasoning and ``message.content`` comes back empty. Give them slack and ask
# for the cheapest reasoning tier.
_REASONING_HEADROOM = 512


def _model_kwargs(max_tokens: int) -> dict:
    """Build per-request kwargs, adding reasoning controls when configured.

    Non-reasoning models (llama, mixtral, ...) simply ignore the extra fields,
    so this stays safe to leave on for every deployment.
    """
    kwargs = {"model": MODEL, "max_tokens": max_tokens}
    effort = getattr(config, "GROQ_REASONING_EFFORT", "")
    if effort:
        kwargs["max_tokens"] = max_tokens + _REASONING_HEADROOM
        kwargs["reasoning_effort"] = effort
    return kwargs


# Analysis prompts (JSON-only; used by the HUD panels and scorecard).
FALLACY_PROMPT = (
    "Analyze this argument for logical fallacies (hasty generalization, false "
    "dichotomy, ad hominem, slippery slope, appeal to emotion, straw man, circular "
    "reasoning, appeal to authority, red herring, etc). Reply ONLY in strict JSON: "
    '{"fallacy": "name or None", "explanation": "1-2 sentences or empty string"}'
)

SCORECARD_PROMPT = (
    "Review this conversation transcript. Score both sides out of 100 (must sum to 100). "
    "List 2-3 user strengths and 2-3 user weaknesses. Reply ONLY in strict JSON: "
    '{"score_you": int, "score_nemesis": int, "strengths": [strings], '
    '"weaknesses": [strings], "summary": "1-2 sentence overall verdict"}'
)

STRENGTH_PROMPT = (
    "Rate the persuasive strength of the user's latest statement from 0 to 100, "
    "considering evidence, logic, relevance and clarity. Reply ONLY in strict JSON: "
    '{"strength": int, "label": "2-4 word verdict"}'
)

# Trailing language tag the model emits in AUTO mode, e.g. "Hola (lang:es)".
LANG_TAG_RE = re.compile(r"\(\s*lang\s*:\s*([A-Za-z]{2})\s*\)\s*[.。！!．]*\s*$")


def split_lang_tag(text: str) -> tuple[str, str | None]:
    """Split a model reply into (clean_text, iso_code_or_None)."""
    if not text:
        return "", None
    stripped = text.strip()
    match = LANG_TAG_RE.search(stripped)
    if match:
        code = match.group(1).lower()
        return stripped[: match.start()].rstrip(), code
    return stripped, None

_client = None


class LLMUnavailable(RuntimeError):
    """Raised after all retries are exhausted."""


def _get_client():
    """Lazily create the OpenAI-compatible client (needs an API key)."""
    global _client
    if _client is None:
        if not config.GROQ_API_KEY:
            raise LLMUnavailable(
                "No Groq API key found. Set the GROQ_API_KEY environment variable "
                "(or nemesis/local_config.py / .env for local development)."
            )
        from openai import OpenAI

        _client = OpenAI(
            api_key=config.GROQ_API_KEY,
            base_url=BASE_URL,
            timeout=config.LLM_TIMEOUT_S,
            max_retries=0,  # we do our own backoff so we can log + fall back
        )
    return _client


def _is_retryable(exc: Exception) -> bool:
    name = exc.__class__.__name__
    if name in {"RateLimitError", "APITimeoutError", "APIConnectionError", "InternalServerError"}:
        return True
    status = getattr(exc, "status_code", None)
    return status in {408, 409, 425, 429, 500, 502, 503, 504}


def _with_retries(fn, *, op: str):
    """Call ``fn()`` with exponential backoff; raise LLMUnavailable when exhausted."""
    attempts = max(1, config.LLM_MAX_RETRIES)
    delay = 0.6
    last: Exception | None = None
    for attempt in range(1, attempts + 1):
        try:
            return fn()
        except LLMUnavailable:
            raise
        except Exception as exc:  # noqa: BLE001 - we classify below
            last = exc
            retryable = _is_retryable(exc)
            log.warning(
                "llm_call_failed op=%s attempt=%d/%d retryable=%s error=%s",
                op, attempt, attempts, retryable, exc.__class__.__name__,
            )
            if not retryable or attempt == attempts:
                break
            time.sleep(delay + random.uniform(0, delay / 2))
            delay = min(delay * 2, 6.0)
    raise LLMUnavailable(f"{op} failed after {attempts} attempt(s): {last.__class__.__name__}") from last


def _chat(system: str, user: str, max_tokens: int, temperature: float = 0.7, *, op: str) -> str:
    def call():
        response = _get_client().chat.completions.create(
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            temperature=temperature,
            **_model_kwargs(max_tokens),
        )
        return (response.choices[0].message.content or "").strip()

    return _with_retries(call, op=op)


def _build_messages(opinion, persona, history, difficulty, aggression, language):
    system, diff = build_persona_system(persona, difficulty, int(aggression or 50), language)
    messages = [{"role": "system", "content": system}]
    for item in history or []:
        # accept both [role, text] pairs and {"role":..,"text":..} dicts
        if isinstance(item, dict):
            role, text = item.get("role"), item.get("text") or item.get("content")
        else:
            role, text = item[0], item[1]
        if role in {"user", "assistant"} and text:
            messages.append({"role": role, "content": str(text)[:1500]})
    messages.append({"role": "user", "content": opinion})
    return messages, diff


# --------------------------------------------------------------------------
# Public API
# --------------------------------------------------------------------------
def counter_argument(opinion, persona, history, difficulty="adept", aggression=50, language="en") -> str:
    """Return the persona's spoken reply to the user's statement (non-streaming).

    The reply may end with a ``(lang:xx)`` auto-detect tag; callers that speak
    the text should run ``split_lang_tag`` on the result first.
    """
    messages, diff = _build_messages(opinion, persona, history, difficulty, aggression, language)

    def call():
        response = _get_client().chat.completions.create(
            messages=messages,
            temperature=diff["temperature"],
            **_model_kwargs(diff["max_tokens"]),
        )
        return (response.choices[0].message.content or "").strip()

    try:
        return _with_retries(call, op="debate") or FALLBACK_COUNTER
    except LLMUnavailable:
        return FALLBACK_COUNTER


def stream_counter_argument(
    opinion, persona, history, difficulty="adept", aggression=50, language="en"
) -> Iterator[str]:
    """Yield text deltas as they arrive from Groq.

    Retries only apply to establishing the stream; once tokens are flowing a
    mid-stream failure yields the fallback sentence so the client always gets
    a coherent ending.
    """
    messages, diff = _build_messages(opinion, persona, history, difficulty, aggression, language)

    def open_stream():
        return _get_client().chat.completions.create(
            messages=messages,
            temperature=diff["temperature"],
            stream=True,
            **_model_kwargs(diff["max_tokens"]),
        )

    try:
        stream = _with_retries(open_stream, op="debate_stream")
    except LLMUnavailable:
        yield FALLBACK_COUNTER
        return

    produced = False
    try:
        for chunk in stream:
            if not chunk.choices:
                continue
            delta = chunk.choices[0].delta
            text = getattr(delta, "content", None)
            if text:
                produced = True
                yield text
    except Exception as exc:  # noqa: BLE001
        log.warning("llm_stream_interrupted error=%s", exc.__class__.__name__)
        yield ("" if not produced else " ") + FALLBACK_COUNTER
        return
    if not produced:
        yield FALLBACK_COUNTER


def _extract_json(text):
    """Try to parse strict JSON, gracefully falling back to a JSON substring."""
    if not text:
        return {}
    # strip ```json fences if present
    cleaned = re.sub(r"^```(?:json)?\s*|\s*```$", "", text.strip(), flags=re.IGNORECASE | re.MULTILINE)
    try:
        data = json.loads(cleaned)
        return data if isinstance(data, dict) else {}
    except (json.JSONDecodeError, ValueError):
        match = re.search(r"\{.*\}", cleaned, re.DOTALL)
        if match:
            try:
                data = json.loads(match.group(0))
                return data if isinstance(data, dict) else {}
            except (json.JSONDecodeError, ValueError):
                pass
        return {}


def _to_int(value, default=0, lo=0, hi=100):
    try:
        return max(lo, min(hi, int(float(value))))
    except (TypeError, ValueError):
        return default


def detect_fallacy(statement) -> dict:
    """Analyze a statement and return {fallacy_name, explanation}."""
    try:
        raw = _chat(FALLACY_PROMPT, statement, max_tokens=120, temperature=0.2, op="fallacy")
    except LLMUnavailable:
        return dict(FALLBACK_FALLACY)
    data = _extract_json(raw)
    name = str(data.get("fallacy") or "None").strip()
    if name.lower() in {"", "none", "null", "no fallacy", "n/a"}:
        name = "None"
    return {"fallacy_name": name, "explanation": str(data.get("explanation") or "").strip()}


def argument_strength(statement) -> dict:
    """Return {strength: 0-100, label: str} for a single user point."""
    try:
        raw = _chat(STRENGTH_PROMPT, statement, max_tokens=60, temperature=0.2, op="strength")
    except LLMUnavailable:
        return {"strength": 50, "label": "Signal lost"}
    data = _extract_json(raw)
    return {
        "strength": _to_int(data.get("strength"), default=50),
        "label": str(data.get("label") or "Assessed")[:40],
    }


def scorecard(transcript) -> dict:
    """Score a full transcript and return a structured report."""
    try:
        raw = _chat(SCORECARD_PROMPT, transcript, max_tokens=300, temperature=0.3, op="scorecard")
    except LLMUnavailable:
        return dict(FALLBACK_SCORECARD)
    data = _extract_json(raw)
    if not data:
        return dict(FALLBACK_SCORECARD)
    score_you = _to_int(data.get("score_you"), default=50)
    score_nemesis = _to_int(data.get("score_nemesis"), default=100 - score_you)
    if score_you + score_nemesis != 100:
        score_nemesis = 100 - score_you
    strengths = data.get("strengths") or []
    weaknesses = data.get("weaknesses") or []
    return {
        "score_you": score_you,
        "score_nemesis": score_nemesis,
        "strengths": [str(s) for s in strengths][:4] if isinstance(strengths, list) else [],
        "weaknesses": [str(w) for w in weaknesses][:4] if isinstance(weaknesses, list) else [],
        "summary": str(data.get("summary") or ""),
    }
