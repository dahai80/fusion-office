// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createGrid } from '../src/ui/grid.js';
import { createErrorSmartTag } from '../src/ui/error-smarttag.js';
import { Workbook } from '../src/core/workbook.js';
import * as P from '../src/lib/puter.js';

// The smart tag's "Explain with AI" action: one ask about the formula, the error and the cells it
// references, answered in the tag's popup; a failure is said there in words, and the action is
// out of reach when the AI is not available.

let consoleError;
beforeEach(() => {
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return 800; } });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return 400; } });
  HTMLCanvasElement.prototype.getContext = () => ({ measureText: (t) => ({ width: t.length * 7 }), font: '' });
  Element.prototype.scrollTo = function scrollTo() {};
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
});
afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

const flush = () => new Promise((r) => setTimeout(r, 5));

function setup() {
  const wb = new Workbook();
  const id = wb.sheets[0].id;
  wb.setInput(id, 0, 0, '10');
  wb.setInput(id, 1, 0, '20');
  wb.setInput(id, 2, 0, '30');
  wb.setInput(id, 0, 1, '=SUM(A1:A4)/0');
  const grid = createGrid({ wb, sheetId: id });
  document.body.replaceChildren(grid.el);
  grid.viewport.getBoundingClientRect = () => ({ left: 0, top: 0, right: 800, bottom: 400, width: 800, height: 400 });
  const tag = createErrorSmartTag({ wb, grid, run() {}, subscribe: () => () => {} });
  grid.setSelection({ active: { r: 0, c: 1 }, anchor: { r: 0, c: 1 }, focus: { r: 0, c: 1 } });
  tag.sync();
  return { wb, id, tag };
}

function menuItem(label) {
  return [...document.querySelectorAll('.menu .menu-item')].find((b) => b.textContent.includes(label));
}

it('asks the AI about the formula, the error and the cells it references, and shows the answer in the popup', async () => {
  vi.spyOn(P, 'canAI').mockReturnValue(true);
  const ask = vi.spyOn(P, 'aiChat').mockResolvedValue('The formula divides by zero because the sum runs past the data. Extend it or guard it with IF.');
  const { tag } = setup();
  expect(tag.el.hidden).toBe(false);
  tag.el.click();
  const item = menuItem('Explain with AI');
  expect(item).toBeTruthy();
  item.click();
  await flush();
  expect(ask).toHaveBeenCalledTimes(1);
  const prompt = ask.mock.calls[0][0];
  expect(prompt).toContain('=SUM(A1:A4)/0');
  expect(prompt).toContain('#DIV/0!');
  expect(prompt).toContain('A1="10"');
  expect(prompt).toContain('A3="30"');
  const popup = document.querySelector('.error-smarttag-ai');
  expect(popup).toBeTruthy();
  expect(popup.querySelector('.error-smarttag-ai-failure').hidden).toBe(true);
  const answer = popup.querySelector('.error-smarttag-ai-answer');
  expect(answer.hidden).toBe(false);
  expect(answer.textContent).toBe('The formula divides by zero because the sum runs past the data. Extend it or guard it with IF.');
});

it('shows the failure in the popup instead of staying silent', async () => {
  vi.spyOn(P, 'canAI').mockReturnValue(true);
  vi.spyOn(P, 'aiChat').mockRejectedValue(new Error('boom'));
  const { tag } = setup();
  tag.el.click();
  menuItem('Explain with AI').click();
  await flush();
  const popup = document.querySelector('.error-smarttag-ai');
  const failure = popup.querySelector('.error-smarttag-ai-failure');
  expect(failure.hidden).toBe(false);
  expect(failure.textContent).toBe('Could not ask the AI: boom');
  expect(popup.querySelector('.error-smarttag-ai-answer').hidden).toBe(true);
});

it('offers the action disabled with a hint when the AI is not available', () => {
  vi.spyOn(P, 'canAI').mockReturnValue(false);
  const ask = vi.spyOn(P, 'aiChat');
  const { tag } = setup();
  tag.el.click();
  const item = menuItem('Explain with AI');
  expect(item.disabled).toBe(true);
  expect(ask).not.toHaveBeenCalled();
});
