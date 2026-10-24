from __future__ import annotations

from io import BytesIO

from openpyxl import Workbook

from office_api.xlsx import parse_workbook


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
