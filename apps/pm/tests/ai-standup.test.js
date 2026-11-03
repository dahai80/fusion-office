// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { todayISO, addDays } from '../src/lib/dates.js';

const ai = vi.hoisted(() => ({ configured: true, reply: { standup: '' }, calls: [], fail: null }));

vi.mock('@fusion-office/ai-client', () => ({
    isConfigured: () => ai.configured,
    jsonChat: vi.fn(async (options) => {
        ai.calls.push(options);
        if (ai.fail) throw ai.fail;
        return ai.reply;
    }),
}));

const fake = vi.hoisted(() => ({ doc: null }));

vi.mock('../src/lib/store.js', () => ({
    docBrief: (doc) => (typeof doc?.brief === 'string' ? doc.brief : ''),
    store: {
        getDoc: () => fake.doc,
        setProjectBrief: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
    },
}));

const { briefPanel } = await import('../src/ui/brief.js');

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const TODAY = todayISO();
const docWith = (tasks) => ({
    id: 'p1', name: 'Release', brief: '',
    columns: [
        { id: 'c1', name: 'To do', done: false },
        { id: 'c2', name: 'In progress', done: false },
        { id: 'c3', name: 'Done', done: true },
    ],
    tasks,
});

function mount() {
    const panel = briefPanel({ projectId: 'p1' });
    document.body.append(panel);
    return panel;
}

const standupButton = (root) =>
    [...root.querySelectorAll('button')].find((b) => b.textContent.includes('AI standup'));

beforeEach(() => {
    ai.configured = true;
    ai.reply = { standup: 'Shipped the parser. The login fix is overdue.' };
    ai.calls = [];
    ai.fail = null;
    fake.doc = docWith([
        { id: 't1', title: 'Fix login', columnId: 'c1', dueDate: addDays(TODAY, -1) },
        { id: 't2', title: 'Draft the notes', columnId: 'c1', dueDate: TODAY },
        { id: 't4', title: 'Review the copy', columnId: 'c1', dueDate: addDays(TODAY, 2) },
        { id: 't3', title: 'Cut the branch', columnId: 'c3', doneAt: Date.parse(addDays(TODAY, -1)) },
    ]);
});

afterEach(() => {
    document.body.replaceChildren();
    vi.clearAllMocks();
});

describe('AI standup', () => {
    it('renders the AI standup into the brief panel', async () => {
        const panel = mount();
        standupButton(panel).click();
        await flush();
        expect(ai.calls).toHaveLength(1);
        const prompt = ai.calls[0].messages.at(-1).content;
        expect(prompt).toContain('Fix login');
        expect(prompt).toContain(`due ${addDays(TODAY, -1)}`);
        expect(prompt).toContain('Cut the branch');
        expect(prompt).toContain('Overdue');
        expect(prompt).toContain('Due today');
        expect(prompt).toContain(TODAY);
        const out = panel.querySelector('.brief-standup');
        expect(out.hidden).toBe(false);
        expect(out.textContent).toContain('Shipped the parser');
        expect(panel.querySelector('.brief-standup-status').textContent).toBe('');
    });

    it('truncates an over-long project and says so in the prompt', async () => {
        fake.doc = docWith(Array.from({ length: 120 }, (_, i) => ({
            id: `t${i}`, title: `Task ${i} ${'x'.repeat(200)}`, columnId: 'c1',
        })));
        const panel = mount();
        standupButton(panel).click();
        await flush();
        const prompt = ai.calls[0].messages.at(-1).content;
        expect(prompt).toContain('[Truncated:');
        expect(prompt).not.toContain('Task 119');
        expect(prompt).toContain('Task 0 ');
    });

    it('says when AI is not configured and sends nothing', async () => {
        ai.configured = false;
        const panel = mount();
        standupButton(panel).click();
        await flush();
        expect(ai.calls).toHaveLength(0);
        expect(panel.querySelector('.brief-standup-status').textContent).toContain('VITE_FUSION_GATEWAY_KEY');
    });

    it('reports a gateway failure inline', async () => {
        ai.fail = new Error('gateway 500');
        const panel = mount();
        standupButton(panel).click();
        await flush();
        expect(panel.querySelector('.brief-standup').textContent).toBe('');
        expect(panel.querySelector('.brief-standup-status').textContent).toContain('fusion-gateway');
    });

    it('says when the assistant returned no summary', async () => {
        ai.reply = { standup: '  ' };
        const panel = mount();
        standupButton(panel).click();
        await flush();
        expect(panel.querySelector('.brief-standup-status').textContent).toContain('no summary');
    });
});
