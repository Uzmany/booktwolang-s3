"""Lightweight Gemini client shared across non-translation features.

Translation already has its own loop in ``translate.py`` (chunked, retried,
literary-prompt baked in). This module is for one-shot prompts that the
Canvas, Vault, and Broadcast surfaces need: auto-tagging journal entries,
compiling node-graphs into outlines, summarising long articles, etc.
"""
from __future__ import annotations

import json
import os
import time

import httpx

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
GEMINI_MODEL_DEFAULT = os.getenv("GEMINI_MODEL_DEFAULT", "gemini-3-flash-preview")
GEMINI_MODEL_PRO = os.getenv("GEMINI_MODEL_PRO", "gemini-3-pro-preview")
GEMINI_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"


class AIError(RuntimeError):
    pass


def gemini_complete(
    *,
    system: str,
    user: str,
    model: str | None = None,
    temperature: float = 0.5,
    response_json: bool = False,
    timeout_s: float = 45.0,
    max_retries: int = 3,
) -> str:
    """Single-shot Gemini call. Returns plain text (or raw JSON string when
    ``response_json=True``). Raises :class:`AIError` on failure."""
    key = GEMINI_API_KEY.strip()
    if not key:
        raise AIError("GEMINI_API_KEY is not configured")

    selected = model or GEMINI_MODEL_DEFAULT
    url = GEMINI_ENDPOINT.format(model=selected)
    payload: dict = {
        "systemInstruction": {"parts": [{"text": system}]},
        "contents": [{"role": "user", "parts": [{"text": user}]}],
        "generationConfig": {
            "temperature": temperature,
            "topP": 0.9,
            "topK": 40,
            "responseMimeType": "application/json" if response_json else "text/plain",
        },
    }

    last_err: Exception | None = None
    for attempt in range(max_retries):
        try:
            with httpx.Client(timeout=timeout_s) as client:
                resp = client.post(
                    url,
                    params={"key": key},
                    headers={"Content-Type": "application/json"},
                    json=payload,
                )
            if resp.status_code in (429, 500, 502, 503, 504):
                last_err = AIError(f"Gemini {resp.status_code}")
                time.sleep(2 ** attempt)
                continue
            if resp.status_code >= 400:
                raise AIError(f"Gemini {resp.status_code}: {resp.text[:400]}")
            data = resp.json()
            candidates = data.get("candidates") or []
            if not candidates:
                raise AIError("Gemini returned no candidates")
            parts = candidates[0].get("content", {}).get("parts") or []
            text = "".join(p.get("text", "") for p in parts if isinstance(p, dict)).strip()
            if not text:
                raise AIError("Gemini returned empty content")
            return text
        except httpx.HTTPError as exc:
            last_err = exc
            time.sleep(2 ** attempt)
    raise AIError(f"Gemini request failed: {last_err}")


def gemini_json(*, system: str, user: str, **kwargs) -> dict | list:
    """Convenience wrapper that parses the JSON response."""
    raw = gemini_complete(system=system, user=user, response_json=True, **kwargs)
    try:
        return json.loads(raw)
    except json.JSONDecodeError as exc:
        # Sometimes Gemini wraps JSON in code fences despite responseMimeType
        cleaned = raw.strip().lstrip("`").rstrip("`")
        if cleaned.startswith("json\n"):
            cleaned = cleaned[5:]
        try:
            return json.loads(cleaned)
        except json.JSONDecodeError:
            raise AIError(f"Gemini did not return valid JSON: {exc}") from exc
