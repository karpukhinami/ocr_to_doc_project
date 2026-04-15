"""
Постобработка DOCX после Pandoc (границы таблиц).
"""

from __future__ import annotations

import io

from docx import Document
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import RGBColor
from docx.table import Table

# Как на фронте --lavender-deep
_SEPARATOR_LAVENDER = RGBColor(0x9E, 0xA4, 0xE8)


def _set_table_borders(table: Table) -> None:
    """Все границы таблицы и ячеек — чёрные, одинарная линия ~1 pt."""
    tbl = table._tbl
    tbl_pr = tbl.tblPr
    if tbl_pr is None:
        tbl_pr = OxmlElement("w:tblPr")
        tbl.insert(0, tbl_pr)

    borders = OxmlElement("w:tblBorders")
    for edge in ("top", "left", "bottom", "right", "insideH", "insideV"):
        el = OxmlElement(f"w:{edge}")
        el.set(qn("w:val"), "single")
        el.set(qn("w:sz"), "8")  # eighths of a point: 8 ≈ 1 pt
        el.set(qn("w:space"), "0")
        el.set(qn("w:color"), "000000")
        borders.append(el)
    tbl_pr.append(borders)


def _iter_all_tables_from_table(table: Table):
    yield table
    for row in table.rows:
        for cell in row.cells:
            for nested in cell.tables:
                yield from _iter_all_tables_from_table(nested)


def _all_tables(doc: Document):
    for t in doc.tables:
        yield from _iter_all_tables_from_table(t)


def _looks_like_separator_line(text: str) -> bool:
    """Строки-разделители вида ====== ... ====== (как в экспорте)."""
    s = text.strip()
    if len(s) < 8:
        return False
    if not s.startswith("=") or not s.endswith("="):
        return False
    if s.count("=") < 6:
        return False
    return True


def style_separator_paragraphs(docx_bytes: bytes) -> bytes:
    """Центрирование и сиреневый цвет текста у абзацев-разделителей (строки из =…=)."""
    doc = Document(io.BytesIO(docx_bytes))
    for p in doc.paragraphs:
        if _looks_like_separator_line(p.text):
            p.alignment = WD_ALIGN_PARAGRAPH.CENTER
            for run in p.runs:
                run.font.color.rgb = _SEPARATOR_LAVENDER
    out = io.BytesIO()
    doc.save(out)
    return out.getvalue()


def apply_black_table_borders(docx_bytes: bytes) -> bytes:
    doc = Document(io.BytesIO(docx_bytes))
    seen: set[int] = set()
    for table in _all_tables(doc):
        tid = id(table._tbl)
        if tid in seen:
            continue
        seen.add(tid)
        _set_table_borders(table)
    out = io.BytesIO()
    doc.save(out)
    return out.getvalue()
