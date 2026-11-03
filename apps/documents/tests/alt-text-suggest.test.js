import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { JSDOM } from 'jsdom';

const ai = vi.hoisted(() => ({ configured: true, fail: false, reply: 'A bar chart of quarterly sales.', calls: [] }));
vi.mock('@fusion-office/ai-client', () => ({
  isConfigured: () => ai.configured,
  chat: async opts => {
    ai.calls.push(opts);
    if (ai.fail) throw new Error('gateway 502: unreachable');
    return ai.reply;
  },
}));

let dom;
beforeAll(() => {
  dom = new JSDOM();
  globalThis.document = dom.window.document;
  globalThis.Node = dom.window.Node;
});
afterAll(() => { delete globalThis.document; delete globalThis.Node; dom.window.close(); });

const image = { id: 1, name: 'sales-chart.png', width: 640, height: 360, alt: '' };
const TEXT = 'Quarterly sales overview.\n￼\nDetails follow in the table below.';
const engine = {
  model: { text: TEXT, range: [26, 27] },
  session: { path: null },
};
function makeContext() {
  const altText = vi.fn(async () => {});
  const context = {
    selected: () => image,
    describe: () => ({ description: '', title: '', decorative: false }),
    kind: () => 'picture',
    onClose: () => {},
    commands: { altText },
    editor: () => engine,
  };
  return { context, altText };
}
const suggestButton = pane => [...pane.node.querySelectorAll('button')].find(b => b.textContent === 'Suggest with AI');
const statusLine = pane => pane.node.querySelector('p.pic-hint[aria-live="polite"]');
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

describe('Alt Text pane: Suggest with AI', () => {
  beforeAll(() => { ai.configured = true; ai.fail = false; ai.calls.length = 0; });

  it('fills the description field with the suggestion and leaves saving to the user', async () => {
    const { createPane } = await import('../src/views/alt-text-pane.js');
    const { context, altText } = makeContext();
    const pane = createPane(context);
    pane.show();
    await tick();
    const button = suggestButton(pane);
    expect(button.disabled).toBe(false);
    button.click();
    await tick(); await tick();
    const description = pane.node.querySelector('textarea');
    expect(description.value).toBe('A bar chart of quarterly sales.');
    expect(statusLine(pane).textContent).toContain('Save');
    // The prompt carries the image's name, size, and the text around it.
    const prompt = ai.calls.at(-1).messages[0].content;
    expect(prompt).toContain('sales-chart.png');
    expect(prompt).toContain('640 x 360');
    expect(prompt).toContain('Quarterly sales overview.');
    expect(prompt).toContain('Details follow in the table below.');
    // Nothing is saved until the user presses Save.
    expect(altText).not.toHaveBeenCalled();
    pane.close();
  });

  it('shows an inline message when the gateway fails and keeps the field unchanged', async () => {
    ai.fail = true;
    const { createPane } = await import('../src/views/alt-text-pane.js');
    const { context, altText } = makeContext();
    const pane = createPane(context);
    pane.show();
    await tick();
    suggestButton(pane).click();
    await tick(); await tick();
    expect(statusLine(pane).textContent).toContain('could not be made');
    expect(pane.node.querySelector('textarea').value).toBe('');
    expect(altText).not.toHaveBeenCalled();
    ai.fail = false;
    pane.close();
  });

  it('disables the suggestion button with a hint when the AI is not configured', async () => {
    ai.configured = false;
    const callsBefore = ai.calls.length;
    const { createPane } = await import('../src/views/alt-text-pane.js');
    const { context } = makeContext();
    const pane = createPane(context);
    pane.show();
    await tick();
    expect(suggestButton(pane).disabled).toBe(true);
    expect(statusLine(pane).textContent).toContain('local AI service');
    expect(ai.calls.length).toBe(callsBefore);
    ai.configured = true;
    pane.close();
  });
});
