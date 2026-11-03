import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { SUMMARIZE_CHAR_CAP, summarizePrompt, summarizeDocument } from '../src/lib/summarize-ai.js';

const ai = vi.hoisted(() => ({ configured: true, fail: false, reply: 'Summary of the document.', calls: [] }));
vi.mock('@fusion-office/ai-client', () => ({
  isConfigured: () => ai.configured,
  chat: async opts => {
    ai.calls.push(opts);
    if (ai.fail) throw new Error('gateway 502: unreachable');
    return ai.reply;
  },
}));

describe('summarize with AI (pure parts)', () => {
  it('keeps short documents whole and says nothing about a cap', () => {
    const p = summarizePrompt('A short document.\n\nSecond paragraph.');
    expect(p).toContain('A short document.');
    expect(p).toContain('Second paragraph.');
    expect(p).not.toContain('longer than');
  });

  it(`truncates at ${SUMMARIZE_CHAR_CAP} characters and says so`, () => {
    const long = 'Head of the document. ' + 'x'.repeat(SUMMARIZE_CHAR_CAP + 5000) + 'TAIL-MARKER';
    const p = summarizePrompt(long);
    expect(p).toContain('longer than');
    expect(p).toContain(`only its first ${SUMMARIZE_CHAR_CAP} characters`);
    expect(p).toContain('Head of the document.');
    expect(p).not.toContain('TAIL-MARKER');
    expect(p.length).toBeLessThan(SUMMARIZE_CHAR_CAP + 2000);
  });

  it('cleans object markers out of the document text', () => {
    expect(summarizePrompt('Before ￼ after')).toContain('Before   after');
    expect(summarizePrompt('Before \u000e after')).toContain('Before   after');
  });

  it('resolves the cleaned summary and surfaces readable failures', async () => {
    expect(await summarizeDocument('Some text', { chat: async () => ({ message: { content: '"The gist."' } }) })).toBe('The gist.');
    await expect(summarizeDocument('   ', { chat: async () => 'x' })).rejects.toThrow('no text to summarize');
    await expect(summarizeDocument('Some text', { chat: async () => { throw new Error('gateway 502'); } })).rejects.toThrow('could not be made');
    await expect(summarizeDocument('Some text', { chat: async () => ({ message: { content: '  ' } }) })).rejects.toThrow('nothing to use');
  });
});

let dom;
beforeAll(() => {
  dom = new JSDOM();
  globalThis.document = dom.window.document;
  globalThis.Node = dom.window.Node;
});
afterAll(() => { delete globalThis.document; delete globalThis.Node; dom.window.close(); });

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const findButton = (pane, label) => [...pane.node.querySelectorAll('button')].find(b => b.textContent === label);

function makeContext() {
  const inserted = [];
  const engine = {
    session: { path: null, body: { text: 'The whole document text goes here.' } },
    finishComposition: () => {},
    editStory: () => {},
    focus: () => {},
    execute: edit => { edit(); return true; },
    model: {
      select: (a, b) => { engine.selection = [a, b]; },
      replace: text => { inserted.push({ at: engine.selection, text }); },
    },
  };
  return { engine, inserted };
}

describe('Summary pane', () => {
  beforeAll(() => { ai.configured = true; ai.fail = false; ai.reply = 'Summary of the document.'; ai.calls.length = 0; });

  it('summarizes the document and inserts the result at the top as one edit', async () => {
    const { createSummarizePane } = await import('../src/views/language-tools.js');
    const { engine, inserted } = makeContext();
    const pane = createSummarizePane({ editor: () => engine, pkg: () => ({}), error: () => {} });
    pane.open();
    await tick();
    const summarize = findButton(pane.pane, 'Summarize');
    expect(summarize.disabled).toBe(false);
    summarize.click();
    await tick(); await tick();
    expect(ai.calls.at(-1).messages[0].content).toContain('The whole document text goes here.');
    expect(pane.pane.node.querySelector('.rv-translation').textContent).toContain('Summary of the document.');
    const insert = findButton(pane.pane, 'Insert at Top');
    expect(insert.disabled).toBe(false);
    insert.click();
    expect(inserted).toEqual([{ at: [0, 0], text: 'Summary of the document.\n' }]);
    pane.pane.close();
  });

  it('shows the failure in the pane and inserts nothing', async () => {
    ai.fail = true;
    const { createSummarizePane } = await import('../src/views/language-tools.js');
    const { engine, inserted } = makeContext();
    const pane = createSummarizePane({ editor: () => engine, pkg: () => ({}), error: () => {} });
    pane.open();
    await tick();
    findButton(pane.pane, 'Summarize').click();
    await tick(); await tick();
    expect(pane.pane.node.querySelector('.rv-status').textContent).toContain('could not be made');
    expect(findButton(pane.pane, 'Insert at Top').disabled).toBe(true);
    expect(inserted).toEqual([]);
    ai.fail = false;
    pane.pane.close();
  });

  it('disables Summarize with a hint when the AI is not configured', async () => {
    ai.configured = false;
    const callsBefore = ai.calls.length;
    const { createSummarizePane } = await import('../src/views/language-tools.js');
    const { engine } = makeContext();
    const pane = createSummarizePane({ editor: () => engine, pkg: () => ({}), error: () => {} });
    pane.open();
    await tick();
    expect(findButton(pane.pane, 'Summarize').disabled).toBe(true);
    expect(pane.pane.node.querySelector('.rv-status').textContent).toContain('local AI service');
    expect(ai.calls.length).toBe(callsBefore);
    ai.configured = true;
    pane.pane.close();
  });
});
