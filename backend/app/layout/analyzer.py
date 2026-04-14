"""
Эвристический layout-анализ скриншотов без тяжёлых DL-моделей.

Выделяет прямоугольные блоки и помечает крупные изолированные области как figure
(диаграммы, вставленные изображения). Текстовые полосы обычно дают мелкие/широкие
контуры; figure — относительно компактные области с заметной площадью.

Сортировка блоков: сверху вниз (y), затем слева направо (x).
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Literal

import cv2
import numpy as np


class BlockType(str, Enum):
    TEXT = "text"
    FIGURE = "figure"


@dataclass
class LayoutBlock:
    kind: Literal["text", "figure"]
    x: int
    y: int
    w: int
    h: int
    """Индекс среди блоков figure (1-based) после сортировки; для text — 0."""
    figure_index: int = 0


def _merge_boxes(boxes: list[tuple[int, int, int, int]], margin: int = 4) -> list[tuple[int, int, int, int]]:
    """Простое слияние пересекающихся/близких AABB."""
    if not boxes:
        return []
    boxes = sorted(boxes, key=lambda b: (b[1], b[0]))
    merged: list[list[int]] = [[*boxes[0]]]
    for x, y, w, h in boxes[1:]:
        px, py, pw, ph = merged[-1]
        if x <= px + pw + margin and y <= py + ph + margin:
            nx = min(px, x)
            ny = min(py, y)
            nx2 = max(px + pw, x + w)
            ny2 = max(py + ph, y + h)
            merged[-1] = [nx, ny, nx2 - nx, ny2 - ny]
        else:
            merged.append([x, y, w, h])
    return [(b[0], b[1], b[2], b[3]) for b in merged]


def _laplacian_std(roi_bgr: np.ndarray) -> float:
    """Грубая метрика «детализированности» участка (фото/схема vs ровная заливка)."""
    if roi_bgr.size == 0:
        return 0.0
    gray = cv2.cvtColor(roi_bgr, cv2.COLOR_BGR2GRAY)
    lap = cv2.Laplacian(gray, cv2.CV_64F)
    return float(lap.std())


def analyze_layout(image_bgr: np.ndarray) -> list[LayoutBlock]:
    """
    Возвращает список блоков; figure нумеруются по порядку чтения (y, x).
    """
    h0, w0 = image_bgr.shape[:2]
    if h0 < 8 or w0 < 8:
        return []

    # Уменьшаем для скорости; масштаб bbox обратно
    max_side = 1200
    scale = 1.0
    work = image_bgr
    if max(h0, w0) > max_side:
        scale = max_side / float(max(h0, w0))
        work = cv2.resize(
            image_bgr,
            (int(w0 * scale), int(h0 * scale)),
            interpolation=cv2.INTER_AREA,
        )

    hw, ww = work.shape[:2]
    gray = cv2.cvtColor(work, cv2.COLOR_BGR2GRAY)
    gray = cv2.bilateralFilter(gray, 5, 50, 50)
    bw = cv2.adaptiveThreshold(
        gray,
        255,
        cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
        cv2.THRESH_BINARY_INV,
        31,
        12,
    )

    # Горизонтальное смыкание — объединяет строки текста в полосы
    kx = max(12, ww // 40)
    ky = max(4, hw // 200)
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (kx, ky))
    dil = cv2.dilate(bw, kernel, iterations=2)

    contours, _ = cv2.findContours(dil, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    page_area = float(hw * ww)
    min_area = max(200, int(page_area * 0.0008))
    raw_boxes: list[tuple[int, int, int, int]] = []
    for cnt in contours:
        x, y, w, h = cv2.boundingRect(cnt)
        if w * h < min_area:
            continue
        raw_boxes.append((x, y, w, h))

    raw_boxes = _merge_boxes(raw_boxes, margin=6)

    blocks: list[LayoutBlock] = []
    for x, y, w, h in raw_boxes:
        # Масштаб обратно в координаты исходного изображения
        ix = int(x / scale)
        iy = int(y / scale)
        iw = int(w / scale)
        ih = int(h / scale)
        ix = max(0, min(ix, w0 - 1))
        iy = max(0, min(iy, h0 - 1))
        iw = max(1, min(iw, w0 - ix))
        ih = max(1, min(ih, h0 - iy))

        area_ratio = (iw * ih) / float(w0 * h0)
        aspect = iw / float(ih) if ih else 999.0
        roi = image_bgr[iy : iy + ih, ix : ix + iw]
        lap_std = _laplacian_std(roi)

        # Полоса на всю ширину и низкая высота — почти наверняка текст
        is_full_width_bar = iw > 0.88 * w0 and ih < 0.12 * h0
        # Крупный блок, не «линия», достаточная детализация или большая площадь
        is_figure = (
            not is_full_width_bar
            and area_ratio >= 0.012
            and 0.22 <= aspect <= 4.5
            and ih >= max(28, int(0.04 * h0))
            and iw >= max(28, int(0.04 * w0))
            and (lap_std >= 4.0 or area_ratio >= 0.04)
        )

        kind: Literal["text", "figure"] = "figure" if is_figure else "text"
        blocks.append(LayoutBlock(kind=kind, x=ix, y=iy, w=iw, h=ih))

    blocks.sort(key=lambda b: (b.y, b.x))

    fig_idx = 0
    for b in blocks:
        if b.kind == "figure":
            fig_idx += 1
            b.figure_index = fig_idx
        else:
            b.figure_index = 0

    return blocks
