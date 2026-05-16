"""Gemini-powered translation helpers.

The translator chunks source text on paragraph boundaries, then sends one
chunk at a time to Gemini with a literary-translation system prompt. Each
translated chunk is persisted to DynamoDB so the user can see progress in
real time, and so a crash mid-translation does not lose completed work.
"""

from __future__ import annotations

import os
import re
import time

import httpx

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
GEMINI_MODEL_DEFAULT = os.getenv("GEMINI_MODEL_DEFAULT", "gemini-3-flash-preview")
GEMINI_MODEL_PRO = os.getenv("GEMINI_MODEL_PRO", "gemini-3-pro-preview")
GEMINI_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"

DEFAULT_CHUNK_TARGET_CHARS = 6000
MAX_CHUNK_CHARS = 12000

LANGUAGES = {
    "en": "English",
    "es": "Spanish",
    "fr": "French",
    "de": "German",
    "it": "Italian",
    "pt": "Portuguese",
    "nl": "Dutch",
    "ru": "Russian",
    "pl": "Polish",
    "uk": "Ukrainian",
    "tr": "Turkish",
    "ar": "Arabic",
    "he": "Hebrew",
    "fa": "Persian",
    "ur": "Urdu",
    "hi": "Hindi",
    "bn": "Bengali",
    "ja": "Japanese",
    "ko": "Korean",
    "zh": "Chinese (Simplified)",
    "zh-Hant": "Chinese (Traditional)",
    "vi": "Vietnamese",
    "th": "Thai",
    "id": "Indonesian",
    "ms": "Malay",
    "sv": "Swedish",
    "no": "Norwegian",
    "da": "Danish",
    "fi": "Finnish",
    "cs": "Czech",
    "el": "Greek",
    "ro": "Romanian",
    "hu": "Hungarian",
}


class TranslationError(RuntimeError):
    """Raised when Gemini returns an error or unexpected response shape."""


def language_name(code: str) -> str:
    return LANGUAGES.get(code, code)


def chunk_text(text: str, target_chars: int = DEFAULT_CHUNK_TARGET_CHARS) -> list[str]:
    """Split text into chunks near paragraph/sentence boundaries.

    Falls back to hard-wrapping only when a single paragraph exceeds
    ``MAX_CHUNK_CHARS`` — that keeps prose translations from getting cut
    mid-sentence except in pathological inputs.
    """
    text = text.replace("\r\n", "\n").replace("\r", "\n").strip()
    if not text:
        return []

    paragraphs = re.split(r"\n{2,}", text)
    chunks: list[str] = []
    buf: list[str] = []
    buf_len = 0

    def flush() -> None:
        nonlocal buf, buf_len
        if buf:
            chunks.append("\n\n".join(buf).strip())
            buf = []
            buf_len = 0

    for para in paragraphs:
        para = para.strip()
        if not para:
            continue
        if len(para) > MAX_CHUNK_CHARS:
            flush()
            sentences = re.split(r"(?<=[.!?])\s+", para)
            sub_buf: list[str] = []
            sub_len = 0
            for sentence in sentences:
                if sub_len + len(sentence) > target_chars and sub_buf:
                    chunks.append(" ".join(sub_buf).strip())
                    sub_buf = []
                    sub_len = 0
                sub_buf.append(sentence)
                sub_len += len(sentence) + 1
            if sub_buf:
                chunks.append(" ".join(sub_buf).strip())
            continue
        if buf_len + len(para) > target_chars and buf:
            flush()
        buf.append(para)
        buf_len += len(para) + 2

    flush()
    return [c for c in chunks if c.strip()]


def build_translation_prompt(source_lang: str, target_lang: str, chunk: str) -> dict:
    src = language_name(source_lang) if source_lang and source_lang != "auto" else "the detected source language"
    tgt = language_name(target_lang)
    system = (
        f"You are a careful literary translator. Translate the user's text "
        f"from {src} into {tgt}. Preserve meaning, tone, register, and any "
        f"existing paragraph breaks. Do not summarize or add commentary. "
        f"Output ONLY the translation, with no preamble or markup."
    )
    return {
        "systemInstruction": {"parts": [{"text": system}]},
        "contents": [
            {
                "role": "user",
                "parts": [{"text": chunk}],
            }
        ],
        "generationConfig": {
            "temperature": 0.3,
            "topP": 0.9,
            "topK": 40,
            "responseMimeType": "text/plain",
        },
    }


def translate_chunk(
    chunk: str,
    *,
    source_lang: str,
    target_lang: str,
    model: str | None = None,
    api_key: str | None = None,
    timeout_s: float = 90.0,
) -> str:
    if not chunk.strip():
        return ""
    key = (api_key or GEMINI_API_KEY).strip()
    if not key:
        raise TranslationError("GEMINI_API_KEY is not configured")
    selected_model = model or GEMINI_MODEL_DEFAULT
    url = GEMINI_ENDPOINT.format(model=selected_model)
    payload = build_translation_prompt(source_lang, target_lang, chunk)

    last_err: Exception | None = None
    for attempt in range(3):
        try:
            with httpx.Client(timeout=timeout_s) as client:
                resp = client.post(
                    url,
                    params={"key": key},
                    headers={"Content-Type": "application/json"},
                    json=payload,
                )
            if resp.status_code in (429, 500, 502, 503, 504):
                last_err = TranslationError(f"Gemini {resp.status_code}: {resp.text[:200]}")
                time.sleep(2 ** attempt)
                continue
            if resp.status_code >= 400:
                raise TranslationError(f"Gemini {resp.status_code}: {resp.text[:500]}")
            data = resp.json()
            candidates = data.get("candidates") or []
            if not candidates:
                raise TranslationError("Gemini returned no candidates")
            parts = candidates[0].get("content", {}).get("parts") or []
            text_parts = [p.get("text", "") for p in parts if isinstance(p, dict)]
            translated = "".join(text_parts).strip()
            if not translated:
                raise TranslationError("Gemini returned empty translation")
            return translated
        except httpx.HTTPError as exc:
            last_err = exc
            time.sleep(2 ** attempt)
    raise TranslationError(f"Gemini request failed after retries: {last_err}")
