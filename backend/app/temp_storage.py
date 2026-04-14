"""
Безопасное создание и удаление временных каталогов под обработку запросов.
"""

from __future__ import annotations

import shutil
import uuid
from pathlib import Path

from .config import Settings


def new_session_dir(settings: Settings) -> Path:
    """
    Создаёт подкаталог с именем UUID внутри TMP_ROOT.
    Все пути дальше должны оставаться внутри этого каталога.
    """
    settings.ensure_tmp_root()
    name = str(uuid.uuid4())
    path = (settings.tmp_root / name).resolve()
    if not str(path).startswith(str(settings.tmp_root.resolve())):
        raise RuntimeError("Invalid temp path resolution")
    path.mkdir(parents=False, exist_ok=False)
    return path


def safe_join(session: Path, *parts: str) -> Path:
    """Собирает путь только внутри session; при выходе за пределы — ошибка."""
    base = session.resolve()
    target = (base.joinpath(*parts)).resolve()
    if not str(target).startswith(str(base)):
        raise ValueError("Path traversal blocked")
    return target


def rm_tree(path: Path) -> None:
    """Удаляет каталог целиком; игнорирует отсутствие."""
    if path.exists() and path.is_dir():
        shutil.rmtree(path, ignore_errors=True)
