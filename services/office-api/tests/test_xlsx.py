from __future__ import annotations

from io import BytesIO

import pytest
from openpyxl import Workbook

from office_api.xlsx import MAX_REGION_CELLS, parse_workbook, sketch_workbook


def workbook_bytes(build) -> bytes:
    workbook = Workbook()
    build(workbook)
    buffer = BytesIO()
    workbook.save(buffer)
    return buffer.getvalue()


def test_single_table_keeps_numbers_and_range() -> None:
    def build(workbook: Workbook) -> None:
        sheet = workbook.active
        sheet.title = "Monitoring"
        sheet.append(["pollutant", "conc_mg_l"])
        sheet.append(["COD", 42.5])
        sheet.append(["NH3-N", 3.1])

    parsed = parse_workbook(workbook_bytes(build))

    assert [sheet["name"] for sheet in parsed["sheets"]] == ["Monitoring"]
    sheet = parsed["sheets"][0]
    assert sheet["unparsed_regions"] == []
    assert len(sheet["tables"]) == 1
    table = sheet["tables"][0]
    assert table["headers"] == ["pollutant", "conc_mg_l"]
    assert table["rows"] == [["COD", 42.5], ["NH3-N", 3.1]]
    assert table["header_row"] == 0
    assert table["range"] == "A1:B3"
    assert table["merged_cells"] == []


def test_blank_rows_and_columns_split_tables() -> None:
    def build(workbook: Workbook) -> None:
        sheet = workbook.active
        sheet.title = "Two"
        sheet.append(["a", "b"])
        sheet.append([1, 2])
        sheet.append([])
        sheet.append(["c", "d"])
        sheet.append([3, 4])
        sheet["E1"] = "x"
        sheet["E2"] = 5

    tables = parse_workbook(workbook_bytes(build))["sheets"][0]["tables"]

    assert [table["range"] for table in tables] == ["A1:B2", "E1:E2", "A4:B5"]
    assert tables[1]["headers"] == ["x"]
    assert tables[1]["rows"] == [[5]]


def test_merged_cells_carry_the_anchor_value() -> None:
    def build(workbook: Workbook) -> None:
        sheet = workbook.active
        sheet.title = "Merged"
        sheet.append(["site", "value"])
        sheet.append(["Plant A", None])
        sheet.merge_cells("A2:B2")
        sheet.append(["Plant B", 7])

    table = parse_workbook(workbook_bytes(build))["sheets"][0]["tables"][0]

    assert table["rows"] == [["Plant A", "Plant A"], ["Plant B", 7]]
    assert table["merged_cells"] == [["r2c1", "r2c2"]]


def test_header_only_and_duplicate_headers_are_unparsed() -> None:
    def build(workbook: Workbook) -> None:
        sheet = workbook.active
        sheet.title = "Odd"
        sheet.append(["only", "header"])
        sheet.append([])
        sheet.append(["dup", "dup"])
        sheet.append([1, 2])

    sheet = parse_workbook(workbook_bytes(build))["sheets"][0]

    assert sheet["tables"] == []
    assert sheet["unparsed_regions"] == ["A1:B1", "A3:B4"]


def test_empty_sheet_reports_nothing() -> None:
    def build(workbook: Workbook) -> None:
        workbook.active.title = "Empty"

    sheet = parse_workbook(workbook_bytes(build))["sheets"][0]

    assert sheet == {"name": "Empty", "tables": [], "unparsed_regions": []}


def test_sketch_reports_structure_without_cell_data() -> None:
    def build(workbook: Workbook) -> None:
        sheet = workbook.active
        sheet.title = "Big"
        sheet.append(["pollutant", "conc_mg_l"])
        sheet.append(["COD", 42.5])
        sheet.append([])
        sheet.append(["only", "header"])

    sketch = sketch_workbook(workbook_bytes(build))

    sheet = sketch["sheets"][0]
    assert sheet["name"] == "Big"
    assert sheet["rows"] == 4
    assert sheet["cols"] == 2
    assert sheet["blocks"] == [
        {"range": "A1:B2", "rows": 2, "cols": 2, "headers": ["pollutant", "conc_mg_l"]},
        {"range": "A4:B4", "rows": 1, "cols": 2, "unparsed": True},
    ]


def test_region_parse_answers_absolute_ranges() -> None:
    def build(workbook: Workbook) -> None:
        sheet = workbook.active
        sheet.title = "Big"
        sheet.append(["a", "b", "c"])
        for row in range(2, 12):
            sheet.append([row, row * 10, row * 100])

    parsed = parse_workbook(workbook_bytes(build), sheet="Big", region="B1:C3")

    table = parsed["sheets"][0]["tables"][0]
    assert table["range"] == "B1:C3"
    assert table["header_row"] == 0
    assert table["headers"] == ["b", "c"]
    assert table["rows"] == [[20, 200], [30, 300]]
    assert parsed["sheets"][0]["unparsed_regions"] == []


def test_region_parse_respects_the_cell_cap() -> None:
    def build(workbook: Workbook) -> None:
        sheet = workbook.active
        sheet.append(["a", "b"])
        sheet.append([1, 2])

    with pytest.raises(ValueError) as error:
        parse_workbook(workbook_bytes(build), sheet="Sheet", region="A1:ZZZ9", max_cells=10)

    assert "10-cell cap" in str(error.value)


def test_region_parse_rejects_a_bad_range() -> None:
    def build(workbook: Workbook) -> None:
        sheet = workbook.active
        sheet.append(["a", "b"])
        sheet.append([1, 2])

    for bad in ("A0:B2", "B2:A1", "nonsense"):
        with pytest.raises(ValueError):
            parse_workbook(workbook_bytes(build), sheet="Sheet", region=bad)


def test_region_cap_is_the_documented_default() -> None:
    assert MAX_REGION_CELLS == 200000
