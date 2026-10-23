import { el } from './dom.js';
import { openModal } from './modal.js';

/** Strict rules refuse entry; legacy non-strict rules only mark cells. */
export function validationAlertStyle(rule) {
  if (!rule || rule.showErrorMessage === false) return null;
  if (rule.strict !== false) return 'stop';
  return ['warning', 'information'].includes(rule.errorStyle) ? rule.errorStyle : null;
}

export function confirmValidation(verdict) {
  const style = validationAlertStyle(verdict.rule);
  if (!style) return Promise.resolve('accept');
  return new Promise(resolve => {
    let result = 'cancel';
    const finish = value => { result = value; modal.close(); };
    const retry = style === 'stop' && el('button.btn.btn-primary', { type: 'button', onclick: () => finish('retry') }, 'Retry');
    const content = el('div', {},
      el('p.modal-text', {}, verdict.message || 'This value does not meet the cell’s validation rule.'),
      el('div.row.row-end', {},
        el('button.btn.btn-ghost', { type: 'button', onclick: () => finish('cancel') }, 'Cancel'),
        style === 'warning' && el('button.btn', { type: 'button', onclick: () => finish('retry') }, 'Edit value'),
        retry || el('button.btn.btn-primary', { type: 'button', onclick: () => finish('accept') }, style === 'warning' ? 'Use value' : 'OK')));
    const modal = openModal({ title: verdict.rule.errorTitle || (style === 'warning' ? 'Invalid value' : 'Check this value'),
      content, initialFocus: retry || null, onClose: () => resolve(result) });
  });
}
