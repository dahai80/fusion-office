/**
 * Data ▸ Data Validation ▸ Circle Invalid Data: the cells whose current value breaks their validation rule
 * (at most 255 per sheet). Only cells holding something are checked; a blank is
 * never circled.
 */
export const MAX_CIRCLES = 255;

export function invalidCells(wb, sheetId, limit = MAX_CIRCLES) {
  const sheet = wb.sheet(sheetId);
  const out = [];
  if (!sheet || !sheet.validations?.length) return { cells: out, more: false };
  const keys = [...sheet.cells.keys()].map((key) => key.split(',').map(Number)).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  for (const [r, c] of keys) {
    const cell = sheet.cells.get(`${r},${c}`);
    if (cell?.v == null && cell?.f == null) continue;
    if (!wb.validationAt(sheetId, r, c)) continue;
    const value = wb.getValue(sheetId, r, c);
    if (value == null || value === '') continue;
    if (wb.validateCell(sheetId, r, c).ok) continue;
    if (out.length === limit) return { cells: out, more: true };
    out.push({ r, c });
  }
  return { cells: out, more: false };
}
