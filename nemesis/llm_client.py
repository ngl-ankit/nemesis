"""Groq LLM client. OpenAI-compatible SDK pointed at Groq's API."""

import json
import os
import re

from openai import OpenAI

from prompts import COUNTER_ARGUMENT_PROMPT, FALLACY_PROMPT, SCORECARD_PROMPT, PERSONAS

# API key resolution order:
#   1. GROQ_API_KEY environment variable
#   2. nemesis/local_config.py  (gitignored - keeps the key out of GitHub)
GROQ_API_KEY = os.environ.get("GROQ_API_KEY", "")
if not GROQ_API_KEY:
    try:
        from local_config import GROQ_API_KEY  # type: ignore
    except ImportError:
        pass

BASE_URL = "https://api.groq.com/openai/v1"
MODEL = "qwen/qwen3.8-27b"

_client = None


def _get_client():
    """Lazily create the OpenAI-compatible client (needs an API key)."""
    global _client
    if _client is None:
        if not GROQ_API_KEY:
            raise RuntimeError(
                "No Groq API key found. Set the GROQ_API_KEY environment "
                "variable, or create nemesis/local_config.py containing "
                'GROQ_API_KEY = "..."'
            )
        _client = OpenAI(api_key=GROQ_API_KEY, base_url=BASE_URL)
    return _client


def _chat(system, user, max_tokens):
    response = _get_client().chat.completions.create(
        model=MODEL,
        messages=[
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        max_tokens=max_tokens,
        temperature=0.7,
    )
    return response.choices[0].message.content.strip()


def counter_argument(opinion, persona, history):
    """Return the strongest counter-argument to the user's opinion.

    history is a list of (role, text) tuples already trimmed by the caller.
    """
    persona_line = PERSONAS.get(persona or "ultron", "")
    system = (persona_line + "\n\n" + COUNTER_ARGUMENT_PROMPT).strip()

    messages = [{"role": "system", "content": system}]
    for role, text in history:
        messages.append({"role": role, "content": text})
    messages.append({"role": "user", "content": opinion})

    response = _get_client().chat.completions.create(
        model=MODEL,
        messages=messages,
        max_tokens=120,
        temperature=0.7,
    )
    return response.choices[0].message.content.strip()


def _extract_json(text):
    """Try to parse strict JSON, gracefully falling back to a JSON substring."""
    try:
        return json.loads(text)
    except (json.JSONDecodeError, ValueError):
        match = re.search(r"\{.*\}", text, re.DOTALL)
        if match:
            try:
                return json.loads(match.group(0))
            except (json.JSONDecodeError, ValueError):
                pass
        return {}


def detect_fallacy(statement):
    """Analyze a statement and return {fallacy_name, explanation}."""
    raw = _chat(FALLACY_PROMPT, statement, max_tokens=120)
    data = _extract_json(raw)
    return {
        "fallacy_name": data.get("fallacy") or "None",
        "explanation": data.get("explanation") or "",
    }


def scorecard(transcript):
    """Score a full transcript and return a structured report."""
    raw = _chat(SCORECARD_PROMPT, transcript, max_tokens=250)
    data = _extract_json(raw)
    return {
        "score_you": int(data.get("score_you", 0) or 0),
        "score_nemesis": int(data.get("score_nemesis", 0) or 0),
        "strengths": data.get("strengths", []),
        "weaknesses": data.get("weaknesses", []),
        "summary": data.get("summary", ""),
    }