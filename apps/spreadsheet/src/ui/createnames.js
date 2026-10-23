/**
 * Create Names from Selection: choose which edges of the selection hold the
 * labels. Each labelled row or column becomes a workbook name in one undo step.
 */

import { el, fieldId } from './dom.js';
import { openModal, fieldAlert } from './modal.js';
import { toast } from './toast.js';
import { rangeName } from '../core/cell.js';
import { createNamesFromSelection, guessLabelEdges, namesFromSelection } from '../core/names-from-selection.js';

export function openCreateNamesDialog(ctx, range) {
  const { wb } = ctx;
  const sheetId = ctx.sheetId();
  const guess = guessLabelEdges(wb, sheetId, range);
  const edges = [['top', 'Top row'], ['left', 'Left column'], ['bottom', 'Bottom row'], ['right', 'Right column']];
  const boxes = Object.fromEntries(edges.map(([key]) => [key, el('input', { type: 'checkbox', id: fieldId('cn'), checked: !!guess[key] })]));
  const preview = el('p.small.muted', { role: 'status' });
  const chosen = () => Object.fromEntries(edges.map(([key]) => [key, boxes[key].checked]));
  const update = () => {
    const names = namesFromSelection(wb, sheetId, range, chosen());
    preview.textContent = names.length
      ? `${names.length} name${names.length === 1 ? '' : 's'}: ${names.slice(0, 6).map(n => n.name).join(', ')}${names.length > 6 ? ', …' : ''}`
      : 'No labels to create names from';
  };
  for (const box of Object.values(boxes)) box.addEventListener('change', update);
  const { alert: error, refuse } = fieldAlert('cn');
  const submit = e => {
    e?.preventDefault();
    if (!edges.some(([key]) => boxes[key].checked)) return refuse(boxes.top, 'Choose at least one edge that holds the labels');
    if (!namesFromSelection(wb, sheetId, range, chosen()).length) return refuse(boxes.top, 'The chosen edges have no labels to name the cells after');
    const { created, replaced, skipped } = createNamesFromSelection(wb, sheetId, range, chosen());
    if (!created && !replaced) return refuse(boxes.top, skipped[0] ? `${skipped[0].name}: ${skipped[0].reason}` : 'No names were created');
    modal.close();
    const parts = [created && `Created ${created} name${created === 1 ? '' : 's'}`, replaced && `replaced ${replaced}`,
      skipped.length && `skipped ${skipped.length} (${skipped[0].name}: ${skipped[0].reason})`].filter(Boolean);
    toast(parts.join('; '), { icon: 'tag', duration: skipped.length ? 5000 : 2600 });
  };
  const content = el('form', { onsubmit: submit },
    el('p.small.muted', {}, `Create names from values in the selected ${rangeName(range)}:`),
    el('fieldset.create-names-edges', {}, el('legend.visually-hidden', {}, 'Labels are in the'),
      ...edges.map(([key, label]) => el('label.find-option', { for: boxes[key].id }, boxes[key], el('span', {}, label)))),
    preview, error,
    el('div.row.row-end', {},
      el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, 'Cancel'),
      el('button.btn.btn-primary', { type: 'submit' }, 'OK')));
  const modal = openModal({ title: 'Create Names from Selection', content, className: 'create-names', initialFocus: boxes.top, onClose: () => ctx.grid?.focus?.() });
  update();
  return modal;
}
