// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { openChartDialog } from '../src/ui/chartdialog.js';
import { closeAllModals } from '../src/ui/modal.js';
import * as P from '../src/lib/puter.js';

// "Suggest with AI" in the chart dialog: one ask over a sample of the selection, whose proposal
// lands in the dialog's own fields for the person to confirm; a failure is said inline.

let consoleError;
beforeEach(() => {
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.useFakeTimers();
  vi.stubGlobal('matchMedia', () => ({ matches: true }));
  document.body.innerHTML = '<div id="app"></div>';
});
afterEach(() => {
  closeAllModals();
  vi.runAllTimers();
  vi.useRealTimers();
  consoleError.mockRestore();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

const settle = () => vi.advanceTimersByTimeAsync(0);

function setup() {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  [['Month', 'Sales'], ['Jan', '100'], ['Feb', '200'], ['Mar', '150'], ['Apr', '120']]
    .forEach((row, r) => row.forEach((value, c) => wb.setInput(id, r, c, value)));
  openChartDialog({ wb, sheetId: () => id, range: () => ({ r1: 0, c1: 0, r2: 4, c2: 1 }), grid: { focus: vi.fn(), selectChart: vi.fn() } });
  const submit = () => document.querySelector('.modal-root form').requestSubmit();
  return { wb, id, submit, charts: () => wb.sheet(id).charts };
}

it('applies the proposal to the dialog fields and creates the chart the person confirms', async () => {
  vi.spyOn(P, 'canAI').mockReturnValue(true);
  const ask = vi.spyOn(P, 'aiChat').mockResolvedValue('```json\n{"chartType": "line", "seriesOrientation": "cols", "title": "Sales by month", "reason": "The data is a series over time."}\n```');
  const { wb, id, submit, charts } = setup();
  const button = document.querySelector('.chart-ai-suggest');
  expect(button.hidden).toBe(false);
  button.click();
  await settle();
  expect(ask).toHaveBeenCalledTimes(1);
  const prompt = ask.mock.calls[0][0];
  expect(prompt).toContain('A1:B5');
  expect(prompt).toContain('a sample of the range');
  expect(prompt).toContain('line (Line)');
  expect(document.querySelector('.chart-ai-status').textContent).toBe('The data is a series over time.');
  expect(document.querySelector('[data-type="line"]').getAttribute('aria-checked')).toBe('true');
  expect(document.querySelector('[aria-label="Title"]').value).toBe('Sales by month');
  expect(document.querySelector('[aria-label="Series in"]').value).toBe('cols');
  submit();
  expect(charts()).toHaveLength(1);
  expect(wb.sheet(id).charts[0].type).toBe('line');
  expect(wb.sheet(id).charts[0].title).toBe('Sales by month');
  expect(wb.sheet(id).charts[0].seriesIn).toBe('cols');
});

it('says a reply that held no supported proposal inline and applies nothing', async () => {
  vi.spyOn(P, 'canAI').mockReturnValue(true);
  vi.spyOn(P, 'aiChat').mockResolvedValue('I would suggest something visual.');
  setup();
  document.querySelector('.chart-ai-suggest').click();
  await settle();
  const error = document.querySelector('.chart-ai-error');
  expect(error.hidden).toBe(false);
  expect(error.textContent).toBe('The reply was not a chart suggestion. Try again.');
  expect(document.querySelector('.chart-ai-status').hidden).toBe(true);
  expect(document.querySelector('[data-type="column"]').getAttribute('aria-checked')).toBe('true');
  expect(document.querySelector('[aria-label="Title"]').value).toBe('');
});

it('shows a gateway failure inline instead of staying silent', async () => {
  vi.spyOn(P, 'canAI').mockReturnValue(true);
  vi.spyOn(P, 'aiChat').mockRejectedValue(new Error('boom'));
  setup();
  document.querySelector('.chart-ai-suggest').click();
  await settle();
  const error = document.querySelector('.chart-ai-error');
  expect(error.hidden).toBe(false);
  expect(error.textContent).toBe('Could not ask the AI: boom');
  expect(document.querySelector('[data-type="column"]').getAttribute('aria-checked')).toBe('true');
  expect(document.querySelector('.chart-ai-suggest').disabled).toBe(false);
});

it('hides the suggestion button when the AI is not available', () => {
  vi.spyOn(P, 'canAI').mockReturnValue(false);
  setup();
  expect(document.querySelector('.chart-ai-suggest').hidden).toBe(true);
});
