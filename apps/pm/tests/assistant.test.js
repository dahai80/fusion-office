// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ai = vi.hoisted(() => ({ configured: true, replies: [], calls: [] }));
vi.mock('@fusion-office/ai-client', async (importOriginal) => ({
    ...(await importOriginal()),
    isConfigured: () => ai.configured,
    createModelPicker: () => null,
    chatStreamEvents: vi.fn(async function* (options) {
        ai.calls.push(options);
        for (const part of ai.replies.shift() || []) yield part;
    }),
}));

const fake = vi.hoisted(() => ({ doc: null, added: [] }));
vi.mock('../src/lib/store.js', () => ({
    PRIORITIES: [
        { value: 'urgent', label: 'Urgent' }, { value: 'high', label: 'High' },
        { value: 'medium', label: 'Medium' }, { value: 'low', label: 'Low' },
    ],
    store: {
        getDoc: () => fake.doc,
        projectEntry: () => ({ name: 'Release' }),
        addTask: (projectId, columnId, patch) => {
            const task = { id: `t${fake.added.length + 1}`, columnId, checklist: [], comments: [], ...patch };
            fake.doc.tasks.push(task);
            fake.added.push(task.title);
            return task;
        },
    },
}));

const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setTimeout(resolve, 0)); };

let openProjectAssistant;

beforeEach(async () => {
    window.matchMedia = window.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
    ai.configured = true;
    ai.replies = [];
    ai.calls = [];
    fake.added = [];
    fake.doc = {
        id: 'p1', name: 'Release', columns: [{ id: 'c1', name: 'To do', done: false }],
        tasks: [], members: [], labels: [], milestones: [],
    };
    ({ openProjectAssistant } = await import('../src/ui/assistant.js'));
});

afterEach(() => {
    document.body.replaceChildren();
    document.body.classList.remove('modal-open');
});

describe('project assistant', () => {
    it('runs a create-task tool and shows the step and answer', async () => {
        ai.replies = [
            [{ type: 'tool', id: 'call_1', name: 'create_task', input: { title: 'Next release', priority: 'high' } }],
            [{ type: 'text', text: 'Created "Next release" in To do.' }],
        ];
        const modal = openProjectAssistant('p1');
        document.querySelector('.pm-as-suggestion').click();
        await flush();
        expect(ai.calls).toHaveLength(2);
        expect(ai.calls[0].tools.map(t => t.function.name)).toContain('create_task');
        expect(ai.calls[0].messages[0].content).toContain('You are the AI assistant');
        expect(fake.added).toEqual(['Next release']);
        expect(document.querySelector('.pm-as-step').textContent).toContain('Create "Next release"');
        expect(document.querySelector('.pm-as-step').dataset.status).toBe('done');
        expect(document.querySelector('.pm-as-answer').textContent).toContain('Created "Next release"');
        modal.close();
    });

    it('says when AI is not configured and sends nothing', async () => {
        ai.configured = false;
        const modal = openProjectAssistant('p1');
        document.querySelector('.pm-as-input').value = 'Add a task';
        document.querySelector('.pm-as-send').click();
        await flush();
        expect(ai.calls).toHaveLength(0);
        expect(document.querySelector('.pm-as-status').textContent).toContain('VITE_FUSION_GATEWAY_KEY');
        modal.close();
    });
});
