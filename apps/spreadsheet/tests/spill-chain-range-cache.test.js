import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';

// Rows that each spill a short array from the row above's total (A2 = SUM(B1#), B2 = SEQUENCE(1,3,A2/1000)):
// every spill landing looked over every range held for one that overlapped it, and each row's three-cell B#
// was held, so 4,000 such rows took five seconds a recalculation, quadratically more as they grew.
// The cost is counted rather than timed: a wall clock bound fails on a loaded machine whatever the
// algorithm, while the held ranges and the evaluations per recalculation say the same thing exactly.
function evaluations(wb, work) {
  const original = wb._context;
  let n = 0;
  wb._context = function (...args) { n++; return original.apply(this, args); };
  try { work(); } finally { wb._context = original; }
  return n;
}

it('a column of spills reading one another recalculates in moments', () => {
  const rows = 4000;
  const wb = new Workbook(), id = wb.activeSheetId;
  const entries = [{ r: 0, c: 0, cell: { v: 1 } }];
  for (let r = 1; r < rows; r++) entries.push({ r, c: 0, cell: { f: `SUM(B${r}#)` } });
  for (let r = 0; r < rows; r++) entries.push({ r, c: 1, cell: { f: `SEQUENCE(1,3,A${r + 1}/1000)` } });
  wb.setCells(id, entries);
  // B1 spills 0.001, 1.001, 2.001, so A2 is 3.003; each row adds three thousandths of the one above, toward 3 / 0.997.
  expect(wb.getValue(id, 1, 0)).toBeCloseTo(3.003, 12);
  expect(wb.getValue(id, rows - 1, 0)).toBeCloseTo(3.00902708124373, 10);
  expect(wb.getValue(id, rows - 1, 3)).toBeCloseTo(wb.getValue(id, rows - 1, 0) / 1000 + 2, 12);
  // Three-cell reads are cheaper to find than to keep, so none is held: a held one per row is what the
  // whole-column scan ran over.
  expect(wb._rangeCache.size).toBe(0);
  expect(wb._rangeRuns.size).toBe(0);
  const after = evaluations(wb, () => {
    wb.setInput(id, 0, 0, '2');
    expect(wb.getValue(id, 1, 0)).toBeCloseTo(3.006, 12);
    expect(wb.getValue(id, rows - 1, 0)).toBeCloseTo(3.00902708124373, 10);
  });
  // A constant number of evaluations per row; the quadratic walk evaluated each row again per landing.
  expect(after).toBeLessThan(rows * 8);
  expect(wb._rangeCache.size).toBe(0);
}, 60000);
