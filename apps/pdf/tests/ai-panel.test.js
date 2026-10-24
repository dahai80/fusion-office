// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAiPanel } from '../src/ai-panel.js';

const state = vi.hoisted(() => ({
    configured: true,
    calls: [],
    replies: [],
    fail: null,
}));

vi.mock('@fusion-office/ai-client', async (importOriginal) => ({
    ...(await importOriginal()),
    isConfigured: () => state.configured,
    chatStreamEvents: vi.fn(async function* (options) {
        state.calls.push(options);
        for (const part of state.replies.shift() || []) yield part;
        if (state.fail) throw state.fail;
    }),
}));

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function commands() {
    return {
        info: vi.fn(() => ({ pages: 3, page: 1, zoom: 100, bookmarks: false })),
        readPages: vi.fn(async () => ({ ok: true, content: '[Page 1] Quarterly revenue grew 12 percent.' })),
        find: vi.fn(async () => ({ ok: true, content: '[{"page":1,"count":1}]' })),
        goTo: vi.fn(() => ({ ok: true, content: 'Showing page 2.' })),
        zoom: vi.fn(async () => ({ ok: true, content: 'Zoom is now fit.' })),
        bookmark: vi.fn(async () => ({ ok: true, changed: true, content: 'Bookmarked page 1 as “Results”.' })),
    };
}

function mount(c = commands()) {
    const panel = createAiPanel({ commands: c, name: () => 'report.pdf' });
    document.body.append(panel.el);
    return { panel, commands: c };
}

beforeEach(() => {
    state.configured = true;
    state.calls = [];
    state.replies = [];
    state.fail = null;
});

afterEach(() => {
    document.body.replaceChildren();
    vi.clearAllMocks();
});

describe('PDF AI panel', () => {
    it('streams an answer and sends the document state with the question', async () => {
        state.replies = [[{ type: 'text', text: 'Revenue grew ' }, { type: 'text', text: '12 percent.' }]];
        const { panel } = mount();
        panel.el.querySelector('.ai-question').value = 'How much did revenue grow?';
        panel.el.querySelector('.btn.primary').click();
        await flush();
        expect(state.calls).toHaveLength(1);
        const content = state.calls[0].messages.at(-1).content;
        expect(content).toContain('3 pages');
        expect(content).toContain('How much did revenue grow?');
        expect(state.calls[0].tools.map(t => t.function.name)).toContain('read_pages');
        expect(panel.el.querySelector('.ai-answer-text').textContent).toBe('Revenue grew 12 percent.');
        expect(panel.el.querySelector('.ai-question').value).toBe('');
        expect(panel.el.querySelector('.ai-status').textContent).toBe('');
    });

    it('asks for a summary from the Summarize button', async () => {
        state.replies = [[{ type: 'text', text: 'A summary.' }]];
        const { panel } = mount();
        [...panel.el.querySelectorAll('button')].find((b) => b.textContent === 'Summarize').click();
        await flush();
        expect(state.calls[0].messages.at(-1).content).toContain('Summarize this document');
        expect(panel.el.querySelector('.ai-answer-text').textContent).toBe('A summary.');
    });

    it('runs a read tool and shows the step before the answer', async () => {
        state.replies = [
            [{ type: 'tool', id: 'call_1', name: 'read_pages', input: { from: 1, count: 1 } }],
            [{ type: 'text', text: 'Revenue grew 12 percent [Page 1].' }],
        ];
        const { panel, commands: c } = mount();
        panel.el.querySelector('.ai-question').value = 'How much did revenue grow?';
        panel.el.querySelector('.btn.primary').click();
        await flush();
        await flush();
        expect(c.readPages).toHaveBeenCalledWith(1, 1);
        expect(state.calls).toHaveLength(2);
        expect(state.calls[1].messages.at(-1).role).toBe('tool');
        expect(state.calls[1].messages.at(-1).content).toContain('Quarterly revenue grew 12 percent.');
        expect(panel.el.querySelector('.ai-step').textContent).toContain('Read pages 1 to 1');
        expect(panel.el.querySelector('.ai-step').dataset.status).toBe('done');
        expect(panel.el.querySelector('.ai-answer-text').textContent).toContain('Revenue grew 12 percent');
    });

    it('adds a bookmark through its tool', async () => {
        state.replies = [
            [{ type: 'tool', id: 'call_2', name: 'add_bookmark', input: { title: 'Results', page: 1 } }],
            [{ type: 'text', text: 'Bookmarked page 1 as “Results”.' }],
        ];
        const { panel, commands: c } = mount();
        panel.el.querySelector('.ai-question').value = 'Bookmark the results page.';
        panel.el.querySelector('.btn.primary').click();
        await flush();
        await flush();
        expect(c.bookmark).toHaveBeenCalledWith('Results', 1);
        expect(panel.el.querySelector('.ai-answer-text').textContent).toContain('Bookmarked');
    });

    it('says when AI is not configured and sends nothing', async () => {
        state.configured = false;
        const { panel } = mount();
        panel.el.querySelector('.ai-question').value = 'Why?';
        panel.el.querySelector('.btn.primary').click();
        await flush();
        expect(state.calls).toHaveLength(0);
        expect(panel.el.querySelector('.ai-status').textContent).toContain('VITE_FUSION_GATEWAY_KEY');
    });

    it('reports a gateway failure in plain words', async () => {
        state.fail = new Error('gateway 401: bad key');
        const { panel } = mount();
        panel.el.querySelector('.ai-question').value = 'Why?';
        panel.el.querySelector('.btn.primary').click();
        await flush();
        expect(panel.el.querySelector('.ai-status').textContent).toContain('VITE_FUSION_GATEWAY_KEY');
    });
});
