// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAiPanel } from '../src/ai-panel.js';

const state = vi.hoisted(() => ({
    configured: true,
    calls: [],
    chunks: [],
    fail: null,
}));

vi.mock('@fusion-office/ai-client', () => ({
    isConfigured: () => state.configured,
    chatStream: vi.fn(async (options, onDelta) => {
        state.calls.push(options);
        for (const chunk of state.chunks) onDelta(chunk);
        if (state.fail) throw state.fail;
    }),
}));

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function mount(text = '[Page 1] Quarterly revenue grew 12 percent.') {
    const panel = createAiPanel({ getText: async () => text });
    document.body.append(panel.el);
    return panel;
}

beforeEach(() => {
    state.configured = true;
    state.calls = [];
    state.chunks = [];
    state.fail = null;
});

afterEach(() => {
    document.body.replaceChildren();
    vi.clearAllMocks();
});

describe('PDF AI panel', () => {
    it('streams an answer from the document text and clears the question', async () => {
        state.chunks = ['Revenue grew ', '12 percent.'];
        const panel = mount();
        panel.el.querySelector('.ai-question').value = 'How much did revenue grow?';
        panel.el.querySelector('.btn.primary').click();
        await flush();
        expect(state.calls).toHaveLength(1);
        const content = state.calls[0].messages.at(-1).content;
        expect(content).toContain('Quarterly revenue grew 12 percent.');
        expect(content).toContain('How much did revenue grow?');
        expect(panel.el.querySelector('.ai-answer-text').textContent).toBe('Revenue grew 12 percent.');
        expect(panel.el.querySelector('.ai-question').value).toBe('');
        expect(panel.el.querySelector('.ai-status').textContent).toBe('');
    });

    it('asks for a summary from the Summarize button', async () => {
        state.chunks = ['A summary.'];
        const panel = mount();
        [...panel.el.querySelectorAll('button')].find((b) => b.textContent === 'Summarize').click();
        await flush();
        expect(state.calls[0].messages.at(-1).content).toContain('Summarize this document');
        expect(panel.el.querySelector('.ai-answer-text').textContent).toBe('A summary.');
    });

    it('says when AI is not configured and sends nothing', async () => {
        state.configured = false;
        const panel = mount();
        panel.el.querySelector('.ai-question').value = 'Why?';
        panel.el.querySelector('.btn.primary').click();
        await flush();
        expect(state.calls).toHaveLength(0);
        expect(panel.el.querySelector('.ai-status').textContent).toContain('VITE_FUSION_GATEWAY_KEY');
    });

    it('reports a gateway failure in plain words', async () => {
        state.fail = new Error('gateway 401: bad key');
        const panel = mount();
        panel.el.querySelector('.ai-question').value = 'Why?';
        panel.el.querySelector('.btn.primary').click();
        await flush();
        expect(panel.el.querySelector('.ai-status').textContent).toContain('VITE_FUSION_GATEWAY_KEY');
    });

    it('says when the PDF has no extractable text', async () => {
        const panel = mount('');
        panel.el.querySelector('.ai-question').value = 'Why?';
        panel.el.querySelector('.btn.primary').click();
        await flush();
        expect(state.calls).toHaveLength(0);
        expect(panel.el.querySelector('.ai-status').textContent).toContain('OCR');
    });
});
