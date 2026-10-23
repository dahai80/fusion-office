// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ai = vi.hoisted(() => ({ configured: true, reply: { items: [] }, calls: [], fail: null }));

vi.mock('@fusion-office/ai-client', () => ({
    isConfigured: () => ai.configured,
    jsonChat: vi.fn(async (options) => {
        ai.calls.push(options);
        if (ai.fail) throw ai.fail;
        return ai.reply;
    }),
}));

const added = vi.hoisted(() => []);

vi.mock('../src/lib/store.js', () => ({
    store: {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addChecklistItem: vi.fn((projectId, taskId, text) => added.push(text)),
        moveChecklistItem: vi.fn(),
        updateChecklistItem: vi.fn(),
        deleteChecklistItem: vi.fn(),
    },
    taskChecklist: (task) => task.checklist || [],
    checklistProgress: (task) => {
        const items = task.checklist || [];
        return { done: items.filter((item) => item.done).length, total: items.length };
    },
}));

const { checklistSection } = await import('../src/ui/checklist.js');

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function mount(task = { id: 't1', title: 'Ship the release', description: 'Cut 1.0', checklist: [] }) {
    const section = checklistSection({ projectId: 'p1', task });
    document.body.append(section);
    return section;
}

const aiButton = (root) => [...root.querySelectorAll('button')].find((b) => b.textContent.includes('Break down'));

beforeEach(() => {
    ai.configured = true;
    ai.reply = { items: ['Write release notes', 'Tag the build'] };
    ai.calls = [];
    ai.fail = null;
    added.length = 0;
});

afterEach(() => {
    document.body.replaceChildren();
    vi.clearAllMocks();
});

describe('AI task breakdown', () => {
    it('turns the task into checklist items', async () => {
        const section = mount();
        aiButton(section).click();
        await flush();
        expect(ai.calls).toHaveLength(1);
        const prompt = ai.calls[0].messages.at(-1).content;
        expect(prompt).toContain('Ship the release');
        expect(prompt).toContain('Cut 1.0');
        expect(added).toEqual(['Write release notes', 'Tag the build']);
        expect(section.querySelector('.ai-status').textContent).toBe('2 steps added.');
    });

    it('says when AI is not configured', async () => {
        ai.configured = false;
        const section = mount();
        aiButton(section).click();
        await flush();
        expect(ai.calls).toHaveLength(0);
        expect(section.querySelector('.ai-status').textContent).toContain('VITE_FUSION_GATEWAY_KEY');
    });

    it('reports a gateway failure', async () => {
        ai.fail = new Error('gateway 500');
        const section = mount();
        aiButton(section).click();
        await flush();
        expect(added).toEqual([]);
        expect(section.querySelector('.ai-status').textContent).toContain('fusion-gateway');
    });

    it('ignores an empty answer', async () => {
        ai.reply = { items: [] };
        const section = mount();
        aiButton(section).click();
        await flush();
        expect(added).toEqual([]);
        expect(section.querySelector('.ai-status').textContent).toContain('no steps');
    });
});
