"""
Замена маркеров [РИС:k] на Markdown-изображения с путями для Pandoc.
"""

from __future__ import annotations

import re
from pathlib import Path

_MARKER_RE = re.compile(r"\[РИС:\s*(\d+)\s*\]", re.IGNORECASE)


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
