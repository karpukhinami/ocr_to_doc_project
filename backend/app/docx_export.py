"""
Вызов Pandoc для преобразования Markdown (+ локальные изображения) в DOCX.
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

from .config import Settings
from .temp_storage import safe_join


def run_pandoc_docx(
    settings: Settings,
    session: Path,
    *,
    markdown_text: str,
    media_dir: Path | None,
) -> bytes:
    """
    Пишет document.md в session, опционально копирует media, запускает pandoc.
    Возвращает байты готового docx.
    """
    md_path = safe_join(session, "document.md")
    md_path.write_text(markdown_text, encoding="utf-8")

    resource_path = str(session)
    if media_dir is not None and media_dir.is_dir():
        dest_media = safe_join(session, "media")
        # Файлы уже могли быть записаны прямо в session/media — не копируем сам в себя
        if media_dir.resolve() != dest_media.resolve():
            if dest_media.exists():
                shutil.rmtree(dest_media, ignore_errors=True)
            shutil.copytree(media_dir, dest_media)

    out_path = safe_join(session, "out.docx")
    cmd = [
        "pandoc",
        str(md_path),
        "-f",
        "markdown",
        "-t",
        "docx",
        "-o",
        str(out_path),
        "--resource-path",
        resource_path,
        "--standalone",
    ]
    proc = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        timeout=settings.pandoc_timeout_sec,
        check=False,
    )
    if proc.returncode != 0:
        err = (proc.stderr or proc.stdout or "").strip()
        raise RuntimeError(f"Pandoc failed ({proc.returncode}): {err}")

    return out_path.read_bytes()
