import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';

// @ looked the formula's row up in the window read of the reference (a fixed distance past the
// data, or a whole column's used area), so a summary sheet longer than its data sheet showed
// #VALUE! from about row 1001 down, where the empty reference should read as zero.
function book() {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  const data = wb.addSheet('Data').id;
  wb.setInput(data, 0, 0, 'x');
  wb.setInput(data, 1, 0, 'y');
  wb.setInput(data, 0, 1, 'z');
  wb.ensureSize(id, 6001, 60);
  return { wb, id };
}

it('intersects a bounded column of another sheet on rows past its read window as zero', () => {
  const { wb, id } = book();
  for (const r of [0, 1, 1499, 4999, 5999]) wb.setInput(id, r, 3, '=@Data!A1:A5000');
  wb.setInput(id, 1499, 4, '=@Data!A1:A5000&"!"');
  wb.setInput(id, 1499, 5, '=INDEX(Data!A1:A5000,1500)');
  expect(wb.getValue(id, 0, 3)).toBe('x');
  expect(wb.getValue(id, 1, 3)).toBe('y');
  expect(wb.getValue(id, 1499, 3)).toBe(0);
  expect(wb.getValue(id, 4999, 3)).toBe(0);
  expect(wb.getValue(id, 5999, 3)).toEqual({ error: '#VALUE!' }); // the row is past the reference itself
  expect(wb.getValue(id, 1499, 4)).toBe('!');
  expect(wb.getValue(id, 1499, 5)).toBe(0);
});

it('intersects a whole column, a whole row and a wide row past the used area as zero', () => {
  const { wb, id } = book();
  wb.setInput(id, 0, 3, '=@Data!A:A');
  wb.setInput(id, 1499, 3, '=@Data!A:A');
  wb.setInput(id, 0, 40, '=@Data!1:1'); // column AO, past the two used columns
  wb.setInput(id, 0, 41, '=@Data!A1:AZ1'); // past the read window of columns too
  wb.setInput(id, 1, 41, '=@Data!A1:AZ1'); // a row is intersected by the formula's column, whatever its row
  wb.setInput(id, 0, 55, '=@Data!A1:AZ1'); // column BD is past the reference itself
  expect(wb.getValue(id, 0, 3)).toBe('x');
  expect(wb.getValue(id, 1499, 3)).toBe(0);
  expect(wb.getValue(id, 0, 40)).toBe(0);
  expect(wb.getValue(id, 0, 41)).toBe(0);
  expect(wb.getValue(id, 1, 41)).toBe(0);
  expect(wb.getValue(id, 0, 55)).toEqual({ error: '#VALUE!' });
});

it('still intersects on its own sheet, and treats a lone cell, an addressless array and a block as before', () => {
  const { wb, id } = book();
  wb.setInput(id, 0, 0, 'p');
  wb.setInput(id, 0, 1, '=@A1:A5000');
  wb.setInput(id, 1499, 1, '=@A1:A5000');
  wb.setInput(id, 0, 2, '=@Data!A1');
  wb.setInput(id, 5, 2, '=@SEQUENCE(3)');
  wb.setInput(id, 6, 2, '=@Data!A1:B5000');
  expect(wb.getValue(id, 0, 1)).toBe('p');
  expect(wb.getValue(id, 1499, 1)).toBe(0);
  expect(wb.getValue(id, 0, 2)).toBe('x');
  expect(wb.getValue(id, 5, 2)).toBe(1);
  expect(wb.getValue(id, 6, 2)).toEqual({ error: '#VALUE!' });
});
