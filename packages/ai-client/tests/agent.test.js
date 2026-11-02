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
