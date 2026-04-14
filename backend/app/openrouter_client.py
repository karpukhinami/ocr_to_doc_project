"""
Клиент OpenRouter: мультимодальный запрос (изображение + текст).
"""

from __future__ import annotations

import base64
from typing import Any

import httpx

from .config import Settings

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
    headers = {
        "Authorization": f"Bearer {settings.openrouter_api_key}",
        "Content-Type": "application/json",
    }
    data_url = image_to_data_url(image_mime, image_bytes)
    user_prompt = build_user_prompt(figure_count)

    payload: dict[str, Any] = {
        "model": settings.openrouter_model,
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": user_prompt},
                    {"type": "image_url", "image_url": {"url": data_url}},
                ],
            }
        ],
        "temperature": 0.1,
    }

    async with httpx.AsyncClient(timeout=settings.openrouter_timeout_sec) as client:
        r = await client.post(url, headers=headers, json=payload)
        r.raise_for_status()
        data = r.json()

    try:
        return str(data["choices"][0]["message"]["content"]).strip()
    except (KeyError, IndexError, TypeError) as e:
        raise RuntimeError(f"Unexpected OpenRouter response: {data!r}") from e
