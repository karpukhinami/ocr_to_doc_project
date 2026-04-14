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

# Базовый промпт из ТЗ + согласование маркеров [РИС:N] с layout.
# В фигурных скобках только плейсхолдер {figure_rules} — остальное литерально.
USER_PROMPT_TEMPLATE = """Распознай текст на изображении максимально точно.
Верни только результат без комментариев.
Сохрани структуру документа (абзацы, списки, таблицы).
Используй Markdown.
Все формулы запиши в LaTeX ($...$ и $$...$$).
Если встречаются изображения, замени их на краткое описание в квадратных скобках.

{figure_rules}
Никаких пояснений, только результат."""


def build_user_prompt(figure_count: int) -> str:
    """Формирует блок правил про маркеры [РИС:N] в зависимости от числа figure."""
    if figure_count <= 0:
        figure_rules = (
            "Если на изображении есть встроенные рисунки без отдельной нумерации, "
            "опиши их кратко в квадратных скобках. Маркеры вида [РИС:N] не используй."
        )
    else:
        nums = ", ".join(str(i) for i in range(1, figure_count + 1))
        figure_rules = f"""ВАЖНО по рисункам: области-рисунки пронумерованы сверху вниз, слева направо.
Для каждого рисунка в этом порядке вставь РОВНО один маркер вида [РИС:K], где K — номер из списка: {nums}.
Используй латиницу РИС и двоеточие как в примере [РИС:1].
Вставь маркер в логичное место текста; если неочевидно — по порядку сверху вниз.
Остальные изображения без номера из этого списка опиши кратко в квадратных скобках."""
    return USER_PROMPT_TEMPLATE.format(figure_rules=figure_rules)


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
    figure_count: int,
) -> str:
    """
    Отправляет изображение в chat/completions и возвращает текст ответа (markdown).
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
    user_prompt = build_user_prompt(figure_count)

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
