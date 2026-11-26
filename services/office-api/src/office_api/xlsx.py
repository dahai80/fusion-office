# Parses .xlsx workbooks into the tables described by issue #1. Sheets are split
# into blocks on empty rows and columns; blocks without a usable header land in
# unparsed_regions rather than being guessed.

from __future__ import annotations

import datetime as dt
import logging
import re
from io import BytesIO
from typing import Any

from openpyxl import load_workbook
from openpyxl.utils import get_column_letter
from openpyxl.worksheet.worksheet import Worksheet

log = logging.getLogger(__name__)

CellValue = str | int | float | bool | None

# Issue #45 (SpreadsheetAgent pattern): a region read must never exceed this
# many cells, so a task-driven region request stays bounded even when the
# range given is the whole sheet.
MAX_REGION_CELLS = 200000

_REGION_RE = re.compile(r"^(?:[^!]+!)?([A-Za-z]+)(\d+):([A-Za-z]+)(\d+)$")


def _column_index(letters: str) -> int:
    index = 0
    for ch in letters.upper():
        index = index * 26 + (ord(ch) - ord("A") + 1)
    return index - 1


def _normalize(value: Any) -> CellValue:
    if value is None:
        return None
    if isinstance(value, (dt.datetime, dt.date, dt.time)):
        return value.isoformat()
    if isinstance(value, (int, float, bool, str)):
        return value
    return str(value)


def _text(value: CellValue) -> str:
    if value is None:
        return ""
    return str(value).strip()


def _grid(sheet: Worksheet) -> tuple[list[list[CellValue]], int, int]:
    rows = max(sheet.max_row or 0, 1)
    cols = max(sheet.max_column or 0, 1)
    for merged in sheet.merged_cells.ranges:
        rows = max(rows, merged.max_row)
        cols = max(cols, merged.max_col)
    grid: list[list[CellValue]] = [[None for _ in range(cols)] for _ in range(rows)]
    for row in range(rows):
        for col in range(cols):
            grid[row][col] = _normalize(sheet.cell(row=row + 1, column=col + 1).value)
    for merged in sheet.merged_cells.ranges:
        anchor = grid[merged.min_row - 1][merged.min_col - 1]
        for row in range(merged.min_row, merged.max_row + 1):
            for col in range(merged.min_col, merged.max_col + 1):
                grid[row - 1][col - 1] = anchor
    return grid, rows, cols


def _occupied(grid: list[list[CellValue]], row: int, col: int) -> bool:
    return _text(grid[row][col]) != ""


def _bands(grid: list[list[CellValue]], rows: int, cols: int) -> list[tuple[int, int]]:
    bands: list[tuple[int, int]] = []
    start: int | None = None
    for row in range(rows):
        filled = any(_occupied(grid, row, col) for col in range(cols))
        if filled and start is None:
            start = row
        elif not filled and start is not None:
            bands.append((start, row - 1))
            start = None
    if start is not None:
        bands.append((start, rows - 1))
    return bands


def _column_runs(
    grid: list[list[CellValue]], top: int, bottom: int, cols: int
) -> list[tuple[int, int]]:
    runs: list[tuple[int, int]] = []
    start: int | None = None
    for col in range(cols):
        filled = any(_occupied(grid, row, col) for row in range(top, bottom + 1))
        if filled and start is None:
            start = col
        elif not filled and start is not None:
            runs.append((start, col - 1))
            start = None
    if start is not None:
        runs.append((start, cols - 1))
    return runs


def _range_name(
    top: int, left: int, bottom: int, right: int, row_off: int = 0, col_off: int = 0
) -> str:
    return (
        f"{get_column_letter(left + col_off + 1)}{top + row_off + 1}"
        f":{get_column_letter(right + col_off + 1)}{bottom + row_off + 1}"
    )


def _merged_in_block(
    sheet: Worksheet, top: int, left: int, bottom: int, right: int
) -> list[list[str]]:
    found: list[list[str]] = []
    for merged in sorted(sheet.merged_cells.ranges, key=lambda r: (r.min_row, r.min_col)):
        if (
            merged.min_row - 1 >= top
            and merged.max_row - 1 <= bottom
            and merged.min_col - 1 >= left
            and merged.max_col - 1 <= right
        ):
            found.append(
                [
                    f"r{merged.min_row}c{merged.min_col}",
                    f"r{merged.max_row}c{merged.max_col}",
                ]
            )
    return found


def _table_from_block(
    sheet: Worksheet,
    grid: list[list[CellValue]],
    top: int,
    left: int,
    bottom: int,
    right: int,
    row_off: int = 0,
    col_off: int = 0,
) -> dict[str, Any] | None:
    if bottom <= top:
        return None
    headers = [_text(grid[top][col]) for col in range(left, right + 1)]
    if not headers or any(not header for header in headers):
        return None
    if len(set(headers)) != len(headers):
        log.info(
            "sheet %s block %s has duplicate headers",
            sheet.title,
            _range_name(top, left, bottom, right, row_off, col_off),
        )
        return None
    rows: list[list[CellValue]] = []
    for row in range(top + 1, bottom + 1):
        rows.append([grid[row][col] for col in range(left, right + 1)])
    if not rows:
        return None
    return {
        "header_row": row_off,
        "headers": headers,
        "rows": rows,
        "merged_cells": _merged_in_block(
            sheet, top + row_off, left + col_off, bottom + row_off, right + col_off
        ),
        "range": _range_name(top, left, bottom, right, row_off, col_off),
    }


def parse_workbook(
    content: bytes,
    sheet: str | None = None,
    region: str | None = None,
    max_cells: int = MAX_REGION_CELLS,
) -> dict[str, Any]:
    """Full parse, or a bounded region parse when sheet+region are given.

    Issue #45 (SpreadsheetAgent pattern): the caller first reads the sketch
    (see sketch_workbook), then asks for one localized region. Region ranges
    answer absolute range names so the two stages join, and a region is
    capped at max_cells with an actionable error instead of loading the
    whole sheet into the caller's context.
    """
    row_off, col_off = 0, 0
    if region:
        match = _REGION_RE.match(region.strip())
        if not match:
            raise ValueError(
                f"region must look like B3:F200 (optional SheetName! prefix), got {region!r}"
            )
        left_c, top_r, right_c, bottom_r = match.groups()
        region_top, region_left = int(top_r) - 1, _column_index(left_c)
        region_bottom, region_right = int(bottom_r) - 1, _column_index(right_c)
        if region_top < 0 or region_bottom < region_top or region_right < region_left:
            raise ValueError(f"region {region!r} ends before it starts")
        if (region_bottom - region_top + 1) * (region_right - region_left + 1) > max_cells:
            raise ValueError(
                f"region {region!r} exceeds the {max_cells}-cell cap; "
                "split it into smaller regions or raise the cap explicitly"
            )
        row_off, col_off = region_top, region_left
    workbook = load_workbook(BytesIO(content), data_only=True)
    sheets: list[dict[str, Any]] = []
    try:
        for candidate in workbook.worksheets:
            if sheet and candidate.title != sheet:
                continue
            grid, rows, cols = _grid(candidate)
            if region:
                width = region_right - region_left + 1
                grid = [
                    row[col_off : col_off + width] for row in grid[region_top : region_bottom + 1]
                ]
                rows, cols = len(grid), width
            tables: list[dict[str, Any]] = []
            unparsed: list[str] = []
            for top, bottom in _bands(grid, rows, cols):
                for left, right in _column_runs(grid, top, bottom, cols):
                    block = _range_name(top, left, bottom, right, row_off, col_off)
                    table = _table_from_block(
                        candidate, grid, top, left, bottom, right, row_off, col_off
                    )
                    if table is None:
                        unparsed.append(block)
                    else:
                        tables.append(table)
            sheets.append({"name": candidate.title, "tables": tables, "unparsed_regions": unparsed})
            log.info(
                "sheet %s: %d tables, %d unparsed regions",
                candidate.title,
                len(tables),
                len(unparsed),
            )
    finally:
        workbook.close()
    return {"sheets": sheets}


def sketch_workbook(content: bytes) -> dict[str, Any]:
    """Stage one of the region-wise pattern (issue #45): structure only.

    Per sheet: dimensions plus every occupied block's range, size and
    headers when the block reads as a table — no cell data beyond headers,
    so a caller can pick a region without loading the sheet.
    """
    workbook = load_workbook(BytesIO(content), data_only=True)
    sheets: list[dict[str, Any]] = []
    try:
        for sheet in workbook.worksheets:
            grid, rows, cols = _grid(sheet)
            blocks: list[dict[str, Any]] = []
            for top, bottom in _bands(grid, rows, cols):
                for left, right in _column_runs(grid, top, bottom, cols):
                    headers = [_text(grid[top][col]) for col in range(left, right + 1)]
                    block: dict[str, Any] = {
                        "range": _range_name(top, left, bottom, right),
                        "rows": bottom - top + 1,
                        "cols": right - left + 1,
                    }
                    if (
                        bottom > top
                        and headers
                        and all(headers)
                        and len(set(headers)) == len(headers)
                    ):
                        block["headers"] = headers
                    else:
                        block["unparsed"] = True
                    blocks.append(block)
            sheets.append({"name": sheet.title, "rows": rows, "cols": cols, "blocks": blocks})
            log.info("sketch sheet %s: %d blocks", sheet.title, len(blocks))
    finally:
        workbook.close()
    return {"sheets": sheets}
