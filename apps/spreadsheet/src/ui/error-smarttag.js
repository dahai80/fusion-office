/**
 * The error-checking smart tag: when the active cell breaks an error-checking rule (see core/error-checking.js),
 * a small warning button stands beside it. Its menu names the problem and offers the fixes that
 * apply (Convert to Number, Copy Formula from Above, Lock Cell…), Show Calculation Steps, Ignore Error, Edit in
 * Formula Bar and Error Checking Options….
 */
import { el } from './dom.js';
import { icon } from './icons.js';
import { openMenu } from './menu.js';
import { openModal } from './modal.js';
import { errorCheckAt, textToNumber, ERROR_RULES, errorCheckingOptions, setErrorCheckingOptions } from '../core/error-checking.js';
import { shiftFormula, mapFormulaRefs } from '../core/refs.js';
import { cellName, cutText } from '../core/cell.js';
import { savePref, syncPref } from '../lib/user-prefs.js';
import * as P from '../lib/puter.js';

const PREF = 'error-checking';
// The cells quoted with an AI error explanation, taken from the ranges the formula references.
const AI_EXPLAIN_CELLS = 20;

/** Keep the Error Checking choices for the person: in this browser and with their account (see lib/user-prefs.js). */
export function saveErrorChecking(options) {
  setErrorCheckingOptions({ ...errorCheckingOptions(), ...options });
  savePref(PREF, errorCheckingOptions());
}

/** Take the account's copy of the Error Checking choices, when there is one. */
export async function syncErrorChecking() {
  const value = await syncPref(PREF, null);
  if (value && typeof value === 'object') setErrorCheckingOptions({ ...errorCheckingOptions(), ...Object.fromEntries(Object.entries(value).filter(([, v]) => typeof v === 'boolean')) });
}

export function createErrorSmartTag(ctx) {
  let found = null; // { r, c, sheetId, check }
  const button = el('button.error-smarttag', { type: 'button', hidden: true, html: icon('alert', 14, 2), 'aria-haspopup': 'menu', tabindex: -1,
    onclick: () => openTagMenu() });

  const fixes = (check, sheetId, r, c) => {
    const { wb } = ctx;
    const cell = wb.getCell(sheetId, r, c);
    const set = (input, label) => wb.transaction(label, () => wb.setInput(sheetId, r, c, input));
    switch (check.key) {
      case 'numberStoredAsText': {
        const n = textToNumber(cell?.v);
        return n == null ? [] : [{ label: 'Convert to Number', onSelect: () => wb.setCells(sheetId, [{ r, c, cell: { ...cell, v: n, f: null, s: cell.s && cell.s.fmt === 'text' ? { ...cell.s, fmt: null } : cell.s } }], 'Convert to number') }];
      }
      case 'formula': {
        const out = [];
        const above = wb.getCell(sheetId, r - 1, c), left = wb.getCell(sheetId, r, c - 1);
        if (r > 0 && above?.f != null) out.push({ label: 'Copy Formula from Above', onSelect: () => set(`=${shiftFormula(above.f, 1, 0)}`, 'Copy formula from above') });
        if (c > 0 && left?.f != null) out.push({ label: 'Copy Formula from Left', onSelect: () => set(`=${shiftFormula(left.f, 0, 1)}`, 'Copy formula from left') });
        return out;
      }
      case 'unlockedFormula':
        return [{ label: 'Lock Cell', onSelect: () => wb.applyStyle(sheetId, { r1: r, c1: c, r2: r, c2: c }, { locked: null }) }];
      case 'twoDigitTextYear': {
        const text = String(cell?.v || '');
        const widen = (century) => text.replace(/(\d{2})\s*$/, (yy) => `${century}${yy}`);
        return [
          { label: `Convert XX to 19XX`, onSelect: () => set(widen('19'), 'Convert year') },
          { label: `Convert XX to 20XX`, onSelect: () => set(widen('20'), 'Convert year') },
        ];
      }
      case 'evalError':
        return [{ label: 'Show Calculation Steps…', onSelect: () => ctx.run('evaluateFormula') }];
      default:
        return [];
    }
  };

  // The cells a formula names, values as shown, up to AI_EXPLAIN_CELLS of them: the context an
  // explanation of the error quotes. Whole-row and whole-column references are passed over.
  function sampleReferencedCells(sheetId, formula) {
    if (formula == null) return [];
    const cells = [];
    mapFormulaRefs(formula, (ref) => {
      if (ref.sheet || ref.kind === 'rows' || ref.kind === 'cols') return ref;
      for (let rr = ref.r1; rr <= ref.r2 && cells.length < AI_EXPLAIN_CELLS; rr++) {
        for (let cc = ref.c1; cc <= ref.c2 && cells.length < AI_EXPLAIN_CELLS; cc++) {
          const text = rr >= 0 && cc >= 0 ? ctx.wb.getDisplay(sheetId, rr, cc) : '';
          if (text) cells.push(`${cellName(rr, cc)}="${cutText(text, 40)}"`);
        }
      }
      return ref;
    });
    return cells;
  }

  // One-shot AI explanation of the error in the tagged cell, shown in a popup beside the tag
  // while it loads. A failure is said there in words, and logged, never silent.
  function explainWithAI(sheetId, r, c, check) {
    const { wb } = ctx;
    const cell = wb.getCell(sheetId, r, c);
    const formula = cell?.f != null ? cell.f : null;
    const cells = sampleReferencedCells(sheetId, formula);
    const prompt = [
      'You explain spreadsheet errors to a non-expert in one short paragraph of plain language: what this error means here and the likely fix. No headings, no code fences, no bullet lists.',
      '',
      `Sheet: "${wb.sheet(sheetId).name}". Cell with the problem: ${cellName(r, c)}.`,
      formula != null ? `Formula: =${formula}` : `Cell value: ${cutText(String(cell?.v ?? ''), 200)}`,
      `Error: ${check.title}${check.error ? ` (${check.error})` : ''}`,
      cells.length ? `Cells the formula references: ${cells.join(', ')}.` : '',
    ].filter(Boolean).join('\n');
    const status = el('p.menu-hint', { role: 'status' }, 'Asking the assistant…');
    const answer = el('p.error-smarttag-ai-answer', { role: 'status', hidden: true });
    const failure = el('p.menu-hint.error-smarttag-ai-failure', { role: 'alert', hidden: true });
    openMenu({
      anchor: button, label: 'AI explanation of this error', minWidth: 280,
      items: [{ custom: el('div.error-smarttag-ai', {}, status, answer, failure) }],
    });
    P.aiChat(prompt, { feature: 'explain-error' }).then((reply) => {
      status.hidden = true;
      answer.textContent = String(reply).trim();
      answer.hidden = false;
    }).catch((err) => {
      console.error('AI error explanation failed', err);
      status.hidden = true;
      failure.textContent = `Could not ask the AI: ${err?.message || 'unknown error'}`;
      failure.hidden = false;
    });
  }

  function openTagMenu() {
    if (!found) return;
    const { sheetId, r, c, check } = found;
    openMenu({
      anchor: button, label: check.title, minWidth: 240,
      items: [
        { header: check.title },
        ...fixes(check, sheetId, r, c),
        P.canAI()
          ? { label: 'Explain with AI', icon: 'sparkle', onSelect: () => explainWithAI(sheetId, r, c, check) }
          : { label: 'Explain with AI', icon: 'sparkle', disabled: true, hint: 'AI is not available here' },
        { label: 'Ignore Error', onSelect: () => ctx.wb.ignoreErrors(sheetId, [{ r1: r, c1: c, r2: r, c2: c }], check.key) },
        { label: 'Edit in Formula Bar', onSelect: () => ctx.focusFormulaBar?.() },
        { separator: true },
        { label: 'Error Checking Options…', onSelect: () => openErrorCheckingOptions(ctx) },
      ],
      onClose: (reason) => { if (reason === 'select') ctx.grid.focus(); },
    });
  }

  function sync() {
    const g = ctx.grid;
    const sel = g?.selection;
    if (!g || g.editing || !sel) { hide(); return; }
    const { r, c } = g.active;
    const check = errorCheckAt(ctx.wb, g.sheetId, r, c);
    if (!check) { hide(); return; }
    found = { sheetId: g.sheetId, r, c, check };
    const rect = g.cellRect(r, c);
    const vp = g.viewport.getBoundingClientRect();
    // The part of the view the cell scrolls in: frozen rows and columns are drawn over the rest of it.
    const pane = g.paneRect?.(r, c) || vp;
    // A cell scrolled out of the sheet's view, or under its frozen panes, takes its tag with it (a viewport not
    // laid out yet has no size to judge by).
    if (vp.width && vp.height && (rect.bottom <= pane.top || rect.top >= pane.bottom || rect.right <= pane.left || rect.left >= pane.right)) { hide(); return; }
    button.hidden = false;
    button.title = check.title;
    button.setAttribute('aria-label', `Error: ${check.title}`);
    // It sits just left of the cell, or right of it when there is no room; beside a cell partly under a
    // frozen pane, at the pane's edge.
    const left = rect.left - 22 >= pane.left ? rect.left - 22 : rect.right + 2;
    button.style.left = `${Math.round(left)}px`;
    button.style.top = `${Math.round(vp.width && vp.height ? Math.max(rect.top + 1, pane.top) : rect.top + 1)}px`;
  }
  function hide() { found = null; button.hidden = true; }

  const onScroll = () => sync();
  ctx.grid?.viewport?.addEventListener('scroll', onScroll, { passive: true });
  const unsubscribe = ctx.subscribe(sync);
  return { el: button, sync, destroy() { unsubscribe(); ctx.grid?.viewport?.removeEventListener('scroll', onScroll); button.remove(); } };
}

/** The Error Checking options: background checking on or off, and each rule. */
export function openErrorCheckingOptions(ctx) {
  const options = { ...errorCheckingOptions() };
  const box = (key, label) => {
    const input = el('input', { type: 'checkbox' });
    input.checked = !!options[key];
    input.addEventListener('change', () => { options[key] = input.checked; });
    return el('label.find-option', {}, input, el('span', {}, label));
  };
  const content = el('form', { onsubmit: (e) => { e.preventDefault(); saveErrorChecking(options); modal.close(); ctx.grid?.redraw?.(); ctx.refreshErrorTag?.(); } },
    box('enabled', 'Enable background error checking'),
    el('h3.field-label', { style: { margin: '10px 0 4px' } }, 'Error checking rules'),
    ...ERROR_RULES.map(([key, label]) => box(key, label)),
    el('div.row.row-end', {},
      el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, 'Cancel'),
      el('button.btn.btn-primary', { type: 'submit' }, 'OK')));
  const modal = openModal({ title: 'Error Checking', content, onClose: () => ctx.grid?.focus?.() });
  return modal;
}
