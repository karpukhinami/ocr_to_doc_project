"""
Клиент OpenRouter: мультимодальный запрос (изображение + текст).

Формат API совместим с OpenAI Chat Completions:
POST {OPENROUTER_BASE_URL}/chat/completions
"""

from __future__ import annotations

import base64
import json
import logging
import os
from typing import Any

import httpx

from .config import Settings

logger = logging.getLogger(__name__)

# Полное изображение скриншота уходит в модель как есть (без вырезанных фрагментов).
USER_PROMPT_VISION = """Распознай текст на изображении максимально точно.
Верни только результат без комментариев.
Сохрани структуру документа (абзацы, списки, таблицы).
Используй Markdown.
Все формулы запиши в LaTeX ($...$ и $$...$$). Если в формулах встречаются незнакомые операторы (например, arctg, пиши их в формулах через \operatorname{})

Картинки, фото, схемы, диаграммы, вставленные изображения и любые нетекстовые фрагменты на скриншоте
не воспроизводи как изображения: для каждого дай краткое описание в квадратных скобках.
Например: [логотип компании], [блок-схема], [скрин интерфейса кнопки].
Не используй синтаксис Markdown-картинок (![...](...)) и не вставляй ссылки на файлы или URL.
Не используй маркеры вида [РИС:1] и подобные — только обычные квадратные скобки с описанием.

Никаких пояснений до или после результата, только распознанный текст и описания в скобках."""


def image_to_data_url(mime: str, raw: bytes) -> str:
    b64 = base64.standard_b64encode(raw).decode("ascii")
    return f"data:{mime};base64,{b64}"


def _extract_message_text(message: dict[str, Any]) -> str:
    """
    OpenRouter/OpenAI может вернуть content строкой или массивом частей
    (например [{'type': 'text', 'text': '...'}]).
    """
    raw = message.get("content")
    if raw is None:
        return ""
    if isinstance(raw, str):
        return raw.strip()
    if isinstance(raw, list):
        parts: list[str] = []
        for block in raw:
            if isinstance(block, dict):
                if block.get("type") == "text" and "text" in block:
                    parts.append(str(block["text"]))
                elif "text" in block:
                    parts.append(str(block["text"]))
            elif isinstance(block, str):
                parts.append(block)
        return "".join(parts).strip()
    return str(raw).strip()


def _openrouter_error_message(status_code: int, body: str) -> str:
    """Текст ошибки из JSON OpenRouter ({ \"error\": { \"message\": ... } }) или сырой ответ."""
    try:
        data = json.loads(body)
    except Exception:
        return f"HTTP {status_code}: {body[:1500]}"
    err = data.get("error")
    if isinstance(err, dict):
        msg = err.get("message") or err.get("metadata") or str(err)
        code = err.get("code")
        if code is not None:
            return f"HTTP {status_code} [{code}]: {msg}"
        return f"HTTP {status_code}: {msg}"
    if isinstance(err, str):
        return f"HTTP {status_code}: {err}"
    return f"HTTP {status_code}: {body[:1500]}"


async def call_openrouter_vision(
    settings: Settings,
    *,
    image_mime: str,
    image_bytes: bytes,
) -> str:
    """
    Отправляет полное изображение в chat/completions (без вырезок), возвращает Markdown-текст.
    """
    if not settings.openrouter_api_key:
        raise RuntimeError("OPENROUTER_API_KEY is not set")

    url = f"{settings.openrouter_base_url}/chat/completions"
    headers: dict[str, str] = {
        "Authorization": f"Bearer {settings.openrouter_api_key}",
        "Content-Type": "application/json",
    }
    # Опционально: идентификация приложения для OpenRouter (рекомендация провайдера)
    referer = os.getenv("OPENROUTER_HTTP_REFERER", "").strip()
    if referer:
        headers["HTTP-Referer"] = referer
    title = os.getenv("OPENROUTER_APP_TITLE", "OCR to Doc").strip()
    if title:
        headers["X-Title"] = title

    data_url = image_to_data_url(image_mime, image_bytes)
    user_prompt = USER_PROMPT_VISION

    model_id = settings.openrouter_model
    payload: dict[str, Any] = {
        "model": model_id,
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": user_prompt},
                    {
                        "type": "image_url",
                        "image_url": {"url": data_url},
                    },
                ],
            }
        ],
        "temperature": 0.1,
    }

    logger.info("OpenRouter request: model=%s, image_bytes=%d", model_id, len(image_bytes))

    async with httpx.AsyncClient(timeout=settings.openrouter_timeout_sec) as client:
        r = await client.post(url, headers=headers, json=payload)
        text_body = r.text
        if r.status_code >= 400:
            raise RuntimeError(_openrouter_error_message(r.status_code, text_body))

        try:
            data = json.loads(text_body)
        except Exception as e:
            raise RuntimeError(f"OpenRouter: не JSON в ответе: {text_body[:800]}") from e

    try:
        choices = data.get("choices")
        if not choices:
            raise KeyError("no choices")
        msg = choices[0].get("message")
        if not isinstance(msg, dict):
            raise RuntimeError(f"Нет message в ответе: {data!r}")
        out = _extract_message_text(msg)
        if not out:
            fr = choices[0].get("finish_reason")
            raise RuntimeError(
                f"Пустой ответ модели (finish_reason={fr!r}). Полный ответ: {data!r}"
            )
        return out
    except (KeyError, IndexError, TypeError) as e:
        raise RuntimeError(f"Неожиданный ответ OpenRouter: {data!r}") from e
