"""
FastAPI: распознавание изображений, конвертация в DOCX, извлечение текста из docx.
"""

from __future__ import annotations

import base64
import logging
import re
from pathlib import Path
from typing import Annotated

import cv2
import numpy as np
from fastapi import Depends, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse, Response
from fastapi.staticfiles import StaticFiles

from .config import Settings, get_settings
from .docx_export import run_pandoc_docx
from .docx_text import extract_text_from_docx
from .layout import analyze_layout
from .markdown_merge import append_missing_figures, apply_figure_markers
from .openrouter_client import call_openrouter_vision
from .temp_storage import new_session_dir, rm_tree, safe_join

logger = logging.getLogger(__name__)

# Собранный фронт (Docker / прод): backend/app/static/
STATIC_DIR = Path(__file__).resolve().parent / "static"

app = FastAPI(title="OCR to Doc API", version="1.0.0")

_init_settings = get_settings()
_init_settings.ensure_tmp_root()
app.add_middleware(
    CORSMiddleware,
    allow_origins=_init_settings.cors_origins or ["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def limit_upload_size(request: Request, call_next):
    """Грубый лимит размера тела запроса по Content-Length."""
    settings = get_settings()
    cl = request.headers.get("content-length")
    if cl is not None:
        try:
            n = int(cl)
            if n > settings.max_upload_bytes:
                return JSONResponse(
                    status_code=413,
                    content={"detail": f"Payload too large (max {settings.max_upload_bytes} bytes)"},
                )
        except ValueError:
            pass
    return await call_next(request)


def get_app_settings() -> Settings:
    return get_settings()


SettingsDep = Annotated[Settings, Depends(get_app_settings)]


@app.on_event("startup")
def on_startup() -> None:
    logging.basicConfig(level=logging.INFO)


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


def _guess_mime(upload: UploadFile) -> str:
    ct = (upload.content_type or "").split(";")[0].strip().lower()
    if ct in ("image/png", "image/jpeg", "image/jpg", "image/webp", "image/gif"):
        return "image/jpeg" if ct == "image/jpg" else ct
    name = (upload.filename or "").lower()
    if name.endswith(".png"):
        return "image/png"
    if name.endswith((".jpg", ".jpeg")):
        return "image/jpeg"
    if name.endswith(".webp"):
        return "image/webp"
    return "image/png"


@app.post("/api/process-image")
async def process_image(
    settings: SettingsDep,
    file: UploadFile = File(...),
) -> JSONResponse:
    """
    Layout → вырезка figure → OpenRouter → markdown + base64 фигур.
    """
    raw = await file.read()
    if len(raw) > settings.max_upload_bytes:
        raise HTTPException(413, "File too large")

    arr = np.frombuffer(raw, dtype=np.uint8)
    image_bgr = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if image_bgr is None:
        raise HTTPException(400, "Invalid image data")

    try:
        blocks = analyze_layout(image_bgr)
        fig_blocks = [b for b in blocks if b.kind == "figure"]
        fig_blocks.sort(key=lambda b: (b.y, b.x))

        # Сначала готовим PNG, затем считаем N для промпта (индексы 1..N подряд)
        crops_png: list[tuple[int, bytes]] = []
        for b in fig_blocks:
            crop = image_bgr[b.y : b.y + b.h, b.x : b.x + b.w]
            if crop.size == 0:
                continue
            ok, buf = cv2.imencode(".png", crop)
            if not ok:
                continue
            crops_png.append((len(crops_png) + 1, buf.tobytes()))

        figure_count = len(crops_png)
        mime = _guess_mime(file)

        md_raw = await call_openrouter_vision(
            settings,
            image_mime=mime,
            image_bytes=raw,
            figure_count=figure_count,
        )
        # Сначала добиваем пропущенные [РИС:N], затем заменяем на Markdown-картинки
        md = append_missing_figures(md_raw, figure_count, media_dir_name="media")
        md = apply_figure_markers(md, media_dir_name="media")

        figures_out: list[dict[str, object]] = []
        for idx, png_bytes in crops_png:
            figures_out.append(
                {
                    "index": idx,
                    "filename": f"fig_{idx}.png",
                    "base64": base64.standard_b64encode(png_bytes).decode("ascii"),
                }
            )

        return JSONResponse(
            {
                "markdown": md,
                "figures": figures_out,
                "figure_count": figure_count,
            }
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("process-image failed")
        raise HTTPException(500, str(e)) from e


@app.post("/api/convert-docx")
async def convert_docx(
    settings: SettingsDep,
    markdown: str = Form(...),
    files: list[UploadFile] | None = File(None),
) -> Response:
    """
    Markdown + файлы изображений (имена fig_N.png) → DOCX через Pandoc.
    """
    session = new_session_dir(settings)
    try:
        media = safe_join(session, "media")
        media.mkdir(parents=True, exist_ok=True)

        # Любые безопасные имена *.png, как в ссылках markdown (media/...)
        safe_png = re.compile(r"^[A-Za-z0-9_.\-]+\.png$")
        for up in files or []:
            if not up.filename:
                continue
            base = Path(up.filename).name
            if not safe_png.match(base):
                raise HTTPException(400, f"Invalid figure filename: {base}")
            data = await up.read()
            if len(data) > settings.max_upload_bytes:
                raise HTTPException(413, "Figure file too large")
            (media / base).write_bytes(data)

        docx_bytes = run_pandoc_docx(settings, session, markdown_text=markdown, media_dir=media)
        return Response(
            content=docx_bytes,
            media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            headers={
                "Content-Disposition": 'attachment; filename="document.docx"',
            },
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("convert-docx failed")
        raise HTTPException(500, str(e)) from e
    finally:
        rm_tree(session)


@app.post("/api/extract-docx-text")
async def extract_docx_text_ep(
    settings: SettingsDep,
    file: UploadFile = File(...),
) -> JSONResponse:
    """Текст из .docx без OCR."""
    raw = await file.read()
    if len(raw) > settings.max_upload_bytes:
        raise HTTPException(413, "File too large")
    if not (file.filename or "").lower().endswith(".docx"):
        raise HTTPException(400, "Expected .docx")
    try:
        text = extract_text_from_docx(raw)
        return JSONResponse({"text": text})
    except Exception as e:
        logger.exception("extract-docx-text failed")
        raise HTTPException(400, f"Cannot read docx: {e}") from e


_assets = STATIC_DIR / "assets"
if _assets.is_dir():
    app.mount("/assets", StaticFiles(directory=str(_assets)), name="assets")


# Отдача SPA из static/ (после сборки фронта)
@app.get("/{full_path:path}", response_model=None)
def spa_fallback(full_path: str) -> Response:
    if not STATIC_DIR.is_dir():
        return PlainTextResponse(
            "Frontend not built. Run Vite dev server or build into backend/app/static.",
            status_code=404,
        )
    if full_path:
        target = (STATIC_DIR / full_path).resolve()
        try:
            target.relative_to(STATIC_DIR.resolve())
        except ValueError:
            return PlainTextResponse("Not found", status_code=404)
        if target.is_file():
            return FileResponse(str(target))
    index = STATIC_DIR / "index.html"
    if index.is_file():
        return FileResponse(str(index))
    return PlainTextResponse("index.html missing", status_code=404)
