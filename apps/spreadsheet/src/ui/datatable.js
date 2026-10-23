/**
 * What-If Analysis ▸ Data Table: the results of one or two formulas for a list of values tried in an input cell.
 */
import { el } from './dom.js';
import { openModal, fieldAlert } from './modal.js';
import { parseCellRef } from '../core/cell.js';

export function openDataTable(ctx) {
  const sheetId = ctx.sheetId();
  const range = ctx.grid.range;
  const field = (label) => el('input.input', { type: 'text', 'aria-label': label, spellcheck: false, autocomplete: 'off' });
  const rowInput = field('Row input cell');
  const colInput = field('Column input cell');
  const { alert: error, refuse } = fieldAlert('data-table');
  // An input cell may be typed with $ signs; it must be on this sheet.
  const read = (input) => {
    const text = input.value.trim().replace(/\$/g, '');
    if (!text) return null;
    return parseCellRef(text) || false;
  };
  const submit = (e) => {
    e?.preventDefault();
    const row = read(rowInput), col = read(colInput);
    if (row === false) return refuse(rowInput, 'Input cell reference is not valid');
    if (col === false) return refuse(colInput, 'Input cell reference is not valid');
    const res = ctx.wb.createDataTable(sheetId, range, row, col);
    if (!res.ok) return refuse(null, res.reason);
    modal.close();
  };
  const content = el('form.data-table-dialog', { onsubmit: submit },
    el('label.field', {}, el('span.field-label', {}, 'Row input cell:'), rowInput),
    el('label.field', {}, el('span.field-label', {}, 'Column input cell:'), colInput),
    error,
    el('div.row.row-end', {},
      el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, 'Cancel'),
      el('button.btn.btn-primary', { type: 'submit' }, 'OK')));
  const modal = openModal({ title: 'Data Table', content, initialFocus: rowInput, onClose: () => ctx.grid?.focus?.() });
  return modal;
}
