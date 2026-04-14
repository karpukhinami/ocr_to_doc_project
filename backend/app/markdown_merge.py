"""
Утилиты для Markdown: старые маркеры [РИС:N], очистка синтаксиса картинок из ответа VL.
"""

from __future__ import annotations

import re
from pathlib import Path

_MARKER_RE = re.compile(r"\[РИС:\s*(\d+)\s*\]", re.IGNORECASE)

# Markdown image: ![alt](url) или ![alt](url "title")
_MD_IMAGE = re.compile(r"!\[[^\]]*\]\([^)]*\)", re.MULTILINE)
# Редко модель вставляет HTML-картинки
_HTML_IMG = re.compile(r"<img\b[^>]*>", re.IGNORECASE)


def strip_markdown_images(text: str) -> str:
    """
    Убирает вставки картинок в Markdown/HTML, чтобы в документ не попали
    «содержательные» картинки из ответа модели (только текст и [описания]).
    """
    s = _MD_IMAGE.sub("", text)
    s = _HTML_IMG.sub("", s)
    # Сжимаем лишние пустые строки после удаления
    s = re.sub(r"\n{3,}", "\n\n", s)
    return s.strip()


def apply_figure_markers(markdown: str, media_dir_name: str = "media") -> str:
    """
    Заменяет [РИС:n] на ![Рис. n](media/fig_n.png).
    Имена файлов согласованы с тем, что кладёт process-image и что шлёт фронт в convert-docx.
    """

    def repl(m: re.Match[str]) -> str:
        n = m.group(1)
        return f"![Рис. {n}]({media_dir_name}/fig_{n}.png)"

    return _MARKER_RE.sub(repl, markdown)


def append_missing_figures(
    markdown: str,
    figure_count: int,
    media_dir_name: str = "media",
) -> str:
    """
    Если модель пропустила маркеры, добавляет в конец недостающие ссылки по порядку.
    """
    found = {int(x) for x in _MARKER_RE.findall(markdown)}
    tail: list[str] = []
    for i in range(1, figure_count + 1):
        if i not in found:
            tail.append(f"\n\n![Рис. {i}]({media_dir_name}/fig_{i}.png)\n")
    if tail:
        markdown = markdown.rstrip() + "".join(tail)
    return markdown


def write_figure_pngs(
    session: Path,
    crops: list[tuple[int, bytes]],
    media_subdir: str = "media",
) -> Path:
    """
    Сохраняет PNG для Pandoc в session/media/fig_k.png.
    crops: список (index, png_bytes).
    """
    media = session / media_subdir
    media.mkdir(parents=True, exist_ok=True)
    for idx, raw in crops:
        path = media / f"fig_{idx}.png"
        path.write_bytes(raw)
    return media
