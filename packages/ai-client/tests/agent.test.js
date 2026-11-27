import { describe, it, expect } from 'vitest';
import { requestMessages, userContent, userText, createAgent } from '../src/agent.js';

describe('requestMessages', () => {
    it('sends the system prompt as the first message', () => {
        const out = requestMessages([{ role: 'user', content: 'hi' }], { system: 'You help.' });
        expect(out[0]).toEqual({ role: 'system', content: 'You help.' });
        expect(out[1].content).toBe('hi');
    });

    it('injects the change log right behind the system prompt', () => {
        const out = requestMessages([{ role: 'user', content: 'hi' }], { system: 'S', changelog: ['Inserted text', 'Replaced the selection (Paragraph 3)'] });
        expect(out).toHaveLength(3);
        expect(out[1].role).toBe('system');
        expect(out[1].content).toContain('- Inserted text');
        expect(out[1].content).toContain('- Replaced the selection (Paragraph 3)');
    });

    it('sends no log message when nothing has changed', () => {
        const out = requestMessages([{ role: 'user', content: 'hi' }], { system: 'S', changelog: [] });
        expect(out).toHaveLength(2);
    });

    it('strips the snapshot from earlier user turns and cuts their long tool results', () => {
        const messages = [
            { role: 'user', content: userContent('first', 'SNAPSHOT') },
            { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{}' } }] },
            { role: 'tool', tool_call_id: 'c1', content: 'x'.repeat(2000) },
            { role: 'user', content: userContent('second', 'SNAPSHOT2') },
        ];
        const out = requestMessages(messages, { system: 'S' });
        expect(out).toHaveLength(5);
        expect(userText(out[1].content)).toBe('first');
        expect(out[3].content).toContain('…');
        expect(out[3].content).toContain('cut from an earlier turn');
        expect(out.at(-1).content).toContain('SNAPSHOT2');
    });

    it('drops the oldest turns whole once the budget is passed, keeping the latest turn', () => {
        const big = 'y'.repeat(60000);
        const messages = [
            { role: 'user', content: big },
            { role: 'assistant', content: 'ok' },
            { role: 'user', content: big },
            { role: 'assistant', content: 'ok' },
            { role: 'user', content: 'latest' },
        ];
        const out = requestMessages(messages, { system: 'S', budget: 70000 });
        expect(userText(out.at(-1).content)).toBe('latest');
        expect(userText(out[1].content)).toBe(big);
    });
});

describe('createAgent change log', () => {
    // A chat stub that answers each round: first with the tool call, then with words.
    function stubChat(callsPerSend) {
        return async function* (messages) {
            const round = (stubChat.rounds = (stubChat.rounds || 0) + 1);
            const calls = callsPerSend[Math.min(round, callsPerSend.length) - 1] || [];
            for (const call of calls) yield { type: 'tool', id: `c${round}`, name: call.name, input: call.input };
            yield { type: 'text', text: 'done' };
        };
    }

    it('records a change the tool reports and sends the log on the next request', async () => {
        const seen = [];
        const agent = createAgent({
            chat: async function* (messages) {
                seen.push(messages);
                if (seen.length === 1) yield { type: 'tool', id: 'c1', name: 'replace_selection', input: { text: 'hi' } };
                yield { type: 'text', text: 'did it' };
            },
            tools: [{ type: 'function', function: { name: 'replace_selection' } }],
            runTool: () => ({ ok: true, changed: true, target: 'Paragraph 2', content: 'Done.' }),
            describe: () => ({ label: 'Replaced the selection' }),
            system: 'S',
        });
        await agent.send('change something');
        expect(seen[0].filter((m) => m.role === 'system')).toHaveLength(1);
        expect(seen[1][1].role).toBe('system');
        expect(seen[1][1].content).toContain('- Replaced the selection (Paragraph 2)');
        agent.reset();
        expect(agent.messages).toHaveLength(0);
    });
});

describe('createAgent outcome signals (#33)', () => {
    function agentWith(outcomes, { approve, runTool } = {}) {
        agentWith.rounds = 0;
        return createAgent({
            chat: async function* (messages) {
                agentWith.rounds = (agentWith.rounds || 0) + 1;
                if (agentWith.rounds === 1) yield { type: 'tool', id: 'c1', name: 'replace_selection', input: { text: 'hi' } };
                yield { type: 'text', text: 'done' };
            },
            tools: [{ type: 'function', function: { name: 'replace_selection' } }],
            runTool: runTool || (() => ({ ok: true, changed: true, target: 'Paragraph 2', content: 'Done.' })),
            describe: () => ({ label: 'Replaced the selection', destructive: true }),
            changes: () => true,
            approve: approve || (async () => true),
            outcomes,
        });
    }
    const signalsOf = (reporter) => reporter.reports.map((r) => r.signal);

    it('reports user_accepted for an approved change and task_success when the turn lands it', async () => {
        const reporter = { report: (...call) => reporter.reports.push(call[0]), reports: [] };
        await agentWith(reporter).send('change something');
        expect(signalsOf(reporter)).toEqual(['user_accepted', 'task_success']);
        expect(reporter.reports[0].detail).toBe('Replaced the selection');
        expect(reporter.reports[0].rolloutId).toMatch(/^ro-[0-9a-f]{16}:e1$/);
        expect(reporter.reports[1].rolloutId).toMatch(/:e2$/);
    });

    it('reports user_rejected for a declined change and no task_success', async () => {
        const reporter = { report: (...call) => reporter.reports.push(call[0]), reports: [] };
        await agentWith(reporter, { approve: async () => false }).send('change something');
        expect(signalsOf(reporter)).toEqual(['user_rejected']);
    });

    it('reports error when the chat request itself fails', async () => {
        const reporter = { report: (...call) => reporter.reports.push(call[0]), reports: [] };
        const agent = createAgent({
            chat: () => { throw new Error('gateway down'); },
            tools: [{ type: 'function', function: { name: 'replace_selection' } }],
            runTool: () => ({ ok: true, content: 'Done.' }),
            outcomes: reporter,
        });
        const result = await agent.send('change something');
        expect(result.error).toBe('gateway down');
        expect(signalsOf(reporter)).toEqual(['error']);
        expect(reporter.reports[0].detail).toBe('gateway down');
    });

    it('carries the transcript messages on every report', async () => {
        const reporter = { report: (...call) => reporter.reports.push(call[0]), reports: [] };
        await agentWith(reporter).send('change something');
        const roles = reporter.reports[1].messages.map((m) => m.role);
        expect(roles).toEqual(['user', 'assistant', 'tool', 'assistant']);
    });
});

describe('createAgent rollout correlation (#38)', () => {
    it('passes one rollout id per turn to every chat round', async () => {
        const seenOpts = [];
        const agent = createAgent({
            chat: async function* (messages, opts) {
                seenOpts.push(opts);
                if (seenOpts.length === 1) yield { type: 'tool', id: 'c1', name: 'replace_selection', input: { text: 'hi' } };
                yield { type: 'text', text: 'done' };
            },
            tools: [{ type: 'function', function: { name: 'replace_selection' } }],
            runTool: () => ({ ok: true, changed: true, content: 'Done.' }),
            describe: () => ({ label: 'Replaced the selection' }),
        });
        await agent.send('change something');
        expect(seenOpts).toHaveLength(2);
        for (const opts of seenOpts) expect(opts.rolloutId).toMatch(/^ro-[0-9a-f]{16}$/);
        expect(seenOpts[1].rolloutId).toBe(seenOpts[0].rolloutId);
    });

    it('mints a fresh rollout id on the next turn', async () => {
        const seenOpts = [];
        const agent = createAgent({
            chat: async function* (messages, opts) { seenOpts.push(opts); yield { type: 'text', text: 'done' }; },
        });
        await agent.send('first');
        await agent.send('second');
        expect(seenOpts[0].rolloutId).toMatch(/^ro-[0-9a-f]{16}$/);
        expect(seenOpts[1].rolloutId).not.toBe(seenOpts[0].rolloutId);
    });
});

describe('createAgent plan-consistency selection (#57)', () => {
    it('resamples a write-class round, emits the verdict, and folds it into the outcome detail', async () => {
        const requests = [];
        const chat = async function* (messages, opts) {
            requests.push(opts);
            if (requests.length <= 3) yield { type: 'tool', id: `c${requests.length}`, name: 'replace_selection', input: { text: 'hi' } };
            yield { type: 'text', text: 'done' };
        };
        const events = [];
        const reporter = { report: (call) => reporter.reports.push(call), reports: [] };
        const agent = createAgent({
            chat,
            tools: [{ type: 'function', function: { name: 'replace_selection' } }],
            runTool: () => ({ ok: true, changed: true, target: 'Paragraph 2', content: 'Done.' }),
            describe: () => ({ label: 'Replaced the selection', destructive: true }),
            changes: () => true,
            approve: async () => true,
            outcomes: reporter,
            consistency: 2,
        });
        await agent.send('change something', event => events.push(event));
        // The greedy round plus two resamples, then the closing round.
        expect(requests).toHaveLength(4);
        expect(requests[1].temperature).toBe(0.7);
        expect(requests[2].temperature).toBe(0.7);
        expect(requests[3].temperature).toBeUndefined();
        const selection = events.find(event => event.type === 'selection');
        expect(selection.selection).toEqual({ samples: 2, agreement: true, agreeCount: 2 });
        const turnEnd = reporter.reports.find(r => r.signal === 'task_success');
        expect(turnEnd.detail).toContain('consistency k=3 samples=2 agreement=true');
    });

    it('keeps single-sample latency on a read-only round', async () => {
        let requests = 0;
        const agent = createAgent({
            chat: async function* () { requests++; if (requests === 1) yield { type: 'tool', id: 'c1', name: 'read_document', input: {} }; yield { type: 'text', text: 'done' }; },
            tools: [{ type: 'function', function: { name: 'read_document' } }],
            runTool: () => ({ ok: true, content: 'The document.' }),
            describe: () => ({ label: 'Read the document' }),
            changes: () => false,
            consistency: 2,
        });
        const events = [];
        await agent.send('read it', event => events.push(event));
        expect(requests).toBe(2);
        expect(events.some(event => event.type === 'selection')).toBe(false);
    });

    it('executes the greedy plan and still reports the turn when samples disagree', async () => {
        const runCalls = [];
        let round = 0;
        const chat = async function* () {
            round++;
            if (round === 1) yield { type: 'tool', id: 'c1', name: 'replace_selection', input: { text: 'greedy' } };
            else if (round === 2) yield { type: 'tool', id: 'c2', name: 'replace_selection', input: { text: 'other' } };
            yield { type: 'text', text: 'done' };
        };
        const reporter = { report: (call) => reporter.reports.push(call), reports: [] };
        const agent = createAgent({
            chat,
            tools: [{ type: 'function', function: { name: 'replace_selection' } }],
            runTool: (name, args) => { runCalls.push(args); return { ok: true, changed: true, content: 'Done.' }; },
            describe: () => ({ label: 'Replaced the selection', destructive: true }),
            changes: () => true,
            approve: async () => true,
            outcomes: reporter,
            consistency: 1,
        });
        await agent.send('change something');
        expect(runCalls).toEqual([{ text: 'greedy' }]);
        const turnEnd = reporter.reports.find(r => r.signal === 'task_success');
        expect(turnEnd.detail).toContain('agreement=false');
    });
});
