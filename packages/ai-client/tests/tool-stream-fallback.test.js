import { describe, it, expect, afterEach, vi } from 'vitest';
import { configure, chatStreamEvents } from '../src/index.js';

configure({ baseUrl: 'http://gateway.test', apiKey: 'k', defaultModel: 'm' });

const TOOL = {
    type: 'function',
    function: {
        name: 'insert_table',
        description: 'Insert a table at the caret.',
        parameters: { type: 'object', properties: { rows: { type: 'array', items: { type: 'array', items: { type: 'string' } } } }, required: ['rows'] },
    },
};

const NL = String.fromCharCode(10);
const encoder = new TextEncoder();
const sseResponse = (deltas, finishReason, completionTokens) => {
    const lines = deltas.map((delta) => 'data: ' + JSON.stringify({ choices: [{ delta }] }) + NL + NL);
    const finish = { choices: [{ delta: null, finish_reason: finishReason }], usage: { completion_tokens: completionTokens } };
    lines.push('data: ' + JSON.stringify(finish) + NL + NL);
    lines.push('data: [DONE]' + NL + NL);
    return new Response(new ReadableStream({
        start(controller) {
            for (const line of lines) controller.enqueue(encoder.encode(line));
            controller.close();
        },
    }), { status: 200 });
};

const nonStreamResponse = (message) => new Response(JSON.stringify({
    choices: [{ message }],
}), { status: 200 });

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('chatStreamEvents tool-stream fallback', () => {
    const callsTo = (bodies) => {
        let i = 0;
        return vi.fn(async () => bodies[Math.min(i++, bodies.length - 1)]());
    };

    it('recovers tool calls with a non-streaming retry when the stream drops them', async () => {
        const fetchMock = callsTo([
            () => sseResponse([{ content: '好的，' }], 'stop', 49),
            () => nonStreamResponse({
                content: '好的，',
                tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'insert_table', arguments: '{"rows":[["a","b"]]}' } }],
            }),
        ]);
        vi.stubGlobal('fetch', fetchMock);
        const events = [];
        for await (const ev of chatStreamEvents({ messages: [{ role: 'user', content: '帮我画一个5行3列的表格' }], tools: [TOOL] })) {
            events.push(ev);
        }
        expect(events).toEqual([
            { type: 'text', text: '好的，' },
            { type: 'tool', id: 'call_1', name: 'insert_table', input: { rows: [['a', 'b']] } },
        ]);
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(JSON.parse(fetchMock.mock.calls[1][1].body).stream).toBe(false);
    });

    it('keeps the prose answer without duplicating it when the retry confirms no tool call', async () => {
        const fetchMock = callsTo([
            () => sseResponse([{ content: '好的，我来说明一下。' }], 'stop', 30),
            () => nonStreamResponse({ content: '好的，我来说明一下。' }),
        ]);
        vi.stubGlobal('fetch', fetchMock);
        const events = [];
        for await (const ev of chatStreamEvents({ messages: [{ role: 'user', content: '解释一下表格语法' }], tools: [TOOL] })) {
            events.push(ev);
        }
        expect(events).toEqual([{ type: 'text', text: '好的，我来说明一下。' }]);
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('does not retry when the stream already delivered tool calls', async () => {
        const fetchMock = callsTo([
            () => sseResponse([
                { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'insert_table', arguments: '{"rows":' } }] },
                { tool_calls: [{ index: 0, function: { arguments: '[["a"]]}' } }] },
            ], 'tool_calls', 20),
        ]);
        vi.stubGlobal('fetch', fetchMock);
        const events = [];
        for await (const ev of chatStreamEvents({ messages: [{ role: 'user', content: '帮我画一个表格' }], tools: [TOOL] })) {
            events.push(ev);
        }
        expect(events).toEqual([{ type: 'tool', id: 'call_1', name: 'insert_table', input: { rows: [['a']] } }]);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});
