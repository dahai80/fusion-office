import { describe, expect, it } from 'vitest';
import { createAgent, requestMessages } from '../src/core/aiagent.js';

/** A model that plays back one scripted reply per request, recording what it was sent. */
function scripted(replies) {
    const requests = [];
    const chat = (messages, options) => {
        requests.push({ messages: messages.map((m) => ({ ...m })), options });
        const parts = replies[requests.length - 1] || [{ type: 'text', text: 'end' }];
        return (async function* stream() { for (const p of parts) yield p; })();
    };
    return { chat, requests };
}

describe('assistant change log', () => {
    it('injects the log right behind the system prompt', () => {
        const out = requestMessages([{ role: 'user', content: 'hi' }], { changelog: ['Set the cell (Sheet1!B2)'] });
        expect(out[0].role).toBe('system');
        expect(out[1].role).toBe('system');
        expect(out[1].content).toContain('- Set the cell (Sheet1!B2)');
        expect(requestMessages([{ role: 'user', content: 'hi' }], { changelog: [] })).toHaveLength(2);
    });

    it('records changes the tools report and clears them on reset', async () => {
        const { chat, requests } = scripted([
            [{ type: 'tool', id: 'c1', name: 'write_cells', input: {} }],
            [{ type: 'text', text: 'done' }],
        ]);
        const agent = createAgent({
            chat,
            runTool: () => ({ ok: true, changed: true, target: 'Sheet1!B2', content: 'Done.' }),
            describe: () => ({ label: 'Set the cell' }),
        });
        await agent.send('set B2');
        const second = requests[1].messages;
        expect(second[1].role).toBe('system');
        expect(second[1].content).toContain('- Set the cell (Sheet1!B2)');
        agent.reset();
        await agent.send('and again');
        expect(requests[2].messages.filter((m) => m.role === 'system')).toHaveLength(1);
    });
});
