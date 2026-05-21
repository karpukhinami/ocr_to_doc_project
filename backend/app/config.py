"""
Переменные окружения и настройки приложения.
"""

from __future__ import annotations

import os
from pathlib import Path


def _split_origins(raw: str) -> list[str]:
    return [o.strip() for o in raw.split(",") if o.strip()]


def _env_bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    v = raw.strip().lower()
    if v in ("1", "true", "yes", "on"):
        return True
    if v in ("0", "false", "no", "off"):
        return False
    return default


class Settings:
    """Загрузка настроек из окружения с разумными значениями по умолчанию."""

    openrouter_api_key: str
    openrouter_base_url: str
    openrouter_model: str
    max_upload_bytes: int
    tmp_root: Path
    openrouter_timeout_sec: float
    pandoc_timeout_sec: float
    cors_origins: list[str]
    show_cost_widget: bool

    def __init__(self) -> None:
        self.openrouter_api_key = os.getenv("OPENROUTER_API_KEY", "").strip()
        self.openrouter_base_url = os.getenv(
            "OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1"
        ).rstrip("/")
        self.openrouter_model = os.getenv(
            "OPENROUTER_MODEL", "qwen/qwen3-vl-235b-a22b-instruct"
        )
        max_mb = float(os.getenv("MAX_UPLOAD_MB", "25"))
        self.max_upload_bytes = int(max_mb * 1024 * 1024)
        root = os.getenv("TMP_ROOT", "./tmp")
        self.tmp_root = Path(root).resolve()
        self.openrouter_timeout_sec = float(os.getenv("OPENROUTER_TIMEOUT_SEC", "300"))
        self.pandoc_timeout_sec = float(os.getenv("PANDOC_TIMEOUT_SEC", "120"))
        cors = os.getenv(
            "CORS_ORIGINS",
            "http://localhost:5173,http://127.0.0.1:5173",
        )
        self.cors_origins = _split_origins(cors)
        self.show_cost_widget = _env_bool("SHOW_COST_WIDGET", True)

    def ensure_tmp_root(self) -> None:
        """Создаёт корень временных файлов (изолированный каталог)."""
        self.tmp_root.mkdir(parents=True, exist_ok=True)


def get_settings() -> Settings:
    return Settings()
