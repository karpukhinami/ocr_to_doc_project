"""
Преобразование $...$ и $$...$$ в сырой HTML перед Pandoc, чтобы сохранить обратные слэши
и команды LaTeX при режиме «не преобразовывать формулы в Word».
"""

from __future__ import annotations

import html
import re


def preprocess_preserve_latex_markdown(md: str) -> str:
    """
    Заменяет блочные и строчные формулы на фрагменты raw HTML (Pandoc + raw_html).
    Внутри $$ убираются лишние переводы строк / «пустые абзацы», формула сжимается в одну строку.
    Вокруг блочной формулы — отдельные абзацы-разделители (пустые абзацы в Word).
    """
    out = md

    def repl_display(m: re.Match[str]) -> str:
        inner = m.group(1).strip()
        inner = re.sub(r"\n\s*\n+", "\n", inner)
        inner = " ".join(inner.split())
        esc = html.escape(inner, quote=False)
        return (
            "\n\n<p>&nbsp;</p>\n"
            f"<p>{esc}</p>\n"
            "<p>&nbsp;</p>\n\n"
        )

    out = re.sub(r"\$\$([\s\S]*?)\$\$", repl_display, out)

    def repl_inline(m: re.Match[str]) -> str:
        inner = m.group(1).strip()
        if re.fullmatch(r"[\d\s.,]+", inner):
            return m.group(0)
        inner = " ".join(inner.split())
        esc = html.escape(inner, quote=False)
        return f"<span>{esc}</span>"

    out = re.sub(r"(?<!\$)\$(?!\$)([^$\n]+?)\$(?!\$)", repl_inline, out)
    return out
