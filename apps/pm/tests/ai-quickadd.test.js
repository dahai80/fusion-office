// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { todayISO, addDays, parseISO } from '../src/lib/dates.js';

const ai = vi.hoisted(() => ({ configured: true, reply: null, calls: [], fail: null }));

vi.mock('@fusion-office/ai-client', () => ({
    isConfigured: () => ai.configured,
    jsonChat: vi.fn(async (options) => {
        ai.calls.push(options);
        if (ai.fail) throw ai.fail;
        return ai.reply;
    }),
}));

const fake = vi.hoisted(() => ({ doc: null, added: [] }));

vi.mock('../src/lib/store.js', () => ({
    LABEL_COLORS: ['#000000', '#111111'],
    store: {
        getDoc: () => fake.doc,
        loadProject: async () => fake.doc,
        projects: [{ id: 'p1', archived: false }],
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addLabel: vi.fn((projectId, patch) => ({ id: `l${patch.name}`, ...patch })),
        addTask: (projectId, columnId, patch) => {
            const task = { id: `t${fake.added.length + 1}`, columnId, ...patch };
            fake.added.push(task);
            return task;
        },
    },
}));

const { openQuickAdd, rememberQuickAddTarget } = await import('../src/ui/quickadd.js');

const TODAY = todayISO();
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0)); };
const waitAi = () => new Promise((resolve) => setTimeout(resolve, 600));

beforeEach(async () => {
    window.matchMedia = window.matchMedia
      || (() => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
    ai.configured = true;
    ai.reply = null;
    ai.calls = [];
    ai.fail = null;
    fake.added = [];
    fake.doc = {
        id: 'p1', name: 'Release',
        columns: [
            { id: 'c1', name: 'To do' },
            { id: 'c2', name: 'In progress' },
            { id: 'c3', name: 'Done', done: true },
        ],
        labels: [], members: [], tasks: [],
    };
    // The composer starts where the last add landed; keep tests independent.
    rememberQuickAddTarget('p1', 'c1');
});

afterEach(() => {
    document.body.replaceChildren();
    document.body.classList.remove('modal-open');
    vi.clearAllMocks();
});

const addBtn = () => [...document.querySelectorAll('button')].find((b) => b.textContent === 'Add task');
const qaInput = () => document.querySelector('.qa-input');

function type(text) {
    qaInput().value = text;
    qaInput().dispatchEvent(new Event('input'));
}

describe('AI quick add', () => {
    it('uses the AI parse when configured and shows the due chip', async () => {
        ai.reply = { title: 'Ship the beta', column: 'In progress', due_date: addDays(TODAY, 2) };
        const modal = openQuickAdd({});
        await flush();
        type('please add ship the beta in progress for the 5th');
        await waitAi();
        expect(ai.calls).toHaveLength(1);
        const prompt = ai.calls[0].messages.at(-1).content;
        expect(prompt).toContain('please add ship the beta in progress for the 5th');
        expect(prompt).toContain('Columns: To do, In progress, Done');
        expect(prompt).toContain(TODAY);
        expect(document.querySelector('.qa-chip-due')).toBeTruthy();
        addBtn().click();
        expect(fake.added).toHaveLength(1);
        expect(fake.added[0].title).toBe('Ship the beta');
        expect(fake.added[0].dueDate).toBe(addDays(TODAY, 2));
        expect(fake.added[0].columnId).toBe('c2');
        modal.close();
    });

    it('falls back to the mechanical parse when the reply names an unknown column', async () => {
        ai.reply = { title: 'Whatever', column: 'Nope', due_date: null };
        const modal = openQuickAdd({});
        await flush();
        type('Call the bank tomorrow');
        await waitAi();
        addBtn().click();
        expect(fake.added[0].title).toBe('Call the bank');
        expect(fake.added[0].dueDate).toBe(addDays(TODAY, 1));
        expect(fake.added[0].columnId).toBe('c1');
        modal.close();
    });

    it('falls back to the mechanical parse on a bad date', async () => {
        ai.reply = { title: 'Renew the license', column: 'To do', due_date: '2026-13-45' };
        const modal = openQuickAdd({});
        await flush();
        type('Renew the license fri');
        await waitAi();
        addBtn().click();
        const friday = addDays(TODAY, (5 - parseISO(TODAY).getDay() + 7) % 7);
        expect(fake.added[0].title).toBe('Renew the license');
        expect(fake.added[0].dueDate).toBe(friday);
        expect(fake.added[0].columnId).toBe('c1');
        modal.close();
    });

    it('falls back to the mechanical parse on a gateway failure', async () => {
        ai.fail = new Error('gateway 500');
        const modal = openQuickAdd({});
        await flush();
        type('Call the bank today');
        await waitAi();
        expect(ai.calls).toHaveLength(1);
        addBtn().click();
        expect(fake.added[0].title).toBe('Call the bank');
        expect(fake.added[0].dueDate).toBe(TODAY);
        expect(fake.added[0].columnId).toBe('c1');
        modal.close();
    });

    it('uses the mechanical parse unchanged when AI is not configured', async () => {
        ai.configured = false;
        const modal = openQuickAdd({});
        await flush();
        type('Call the bank tomorrow');
        await waitAi();
        expect(ai.calls).toHaveLength(0);
        addBtn().click();
        expect(fake.added[0].title).toBe('Call the bank');
        expect(fake.added[0].dueDate).toBe(addDays(TODAY, 1));
        modal.close();
    });
});
