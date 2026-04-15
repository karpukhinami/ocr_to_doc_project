"""
Нормализация блочных формул $$...$$ для экспорта: убираются только лишние пустые абзацы внутри,
содержимое и знаки $ не меняются. Остальной LaTeX идёт в Pandoc как есть (без tex_math_dollars).
"""

from __future__ import annotations

import re


def normalize_display_math_blank_lines(md: str) -> str:
    """
    Внутри каждой пары $$ ... $$ схлопываются последовательности из двух и более переводов строк
    в один перевод строки. Внешние границы и остальной текст не трогаются.
    """

    def repl(m: re.Match[str]) -> str:
        inner = m.group(1)
        inner = re.sub(r"\n\s*\n+", "\n", inner)
        return "$$" + inner.strip() + "$$"

    return re.sub(r"\$\$([\s\S]*?)\$\$", repl, md)
