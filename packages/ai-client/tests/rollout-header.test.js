// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { chat, chatStreamEvents, configure, resetPolicyCache, resetStaticKeyWarning } from '../src/index.js';
import { setSelectedModel } from '../src/model-picker.js';

beforeEach(() => {
    resetPolicyCache();
    resetStaticKeyWarning();
    setSelectedModel('');
    configure({ defaultModel: 'glm-5' });
});

function streamResponse(events) {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
        start(controller) {
            for (const event of events) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();
        },
    });
    return { ok: true, body: stream, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) };
}

describe('X-Fusion-Rollout-Id correlation header (issue #38)', () => {
    it('chat sends the header when a rollout id is given', async () => {
        globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) }));
        await chat({ messages: [{ role: 'user', content: 'hi' }], rolloutId: 'ro-abc1234567890abc' });
        const headers = globalThis.fetch.mock.calls[0][1].headers;
        expect(headers['X-Fusion-Rollout-Id']).toBe('ro-abc1234567890abc');
    });

    it('chat sends no rollout header when none is given', async () => {
        globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) }));
        await chat({ messages: [{ role: 'user', content: 'hi' }] });
        const headers = globalThis.fetch.mock.calls[0][1].headers;
        expect(headers['X-Fusion-Rollout-Id']).toBeUndefined();
    });

    it('carries the same id and resolved model through a non-stream tool recovery', async () => {
        const onModel = vi.fn();
        globalThis.fetch = vi.fn().mockResolvedValueOnce(streamResponse([
            { choices: [{ delta: { content: 'Looking.' } }], usage: { completion_tokens: 1 } },
        ])).mockResolvedValueOnce({ ok: true, json: async () => ({ choices: [{ message: { content: 'Done' } }] }) });
        const rolloutId = 'ro-abc1234567890abc';
        const stream = chatStreamEvents({ messages: [{ role: 'user', content: 'hello' }],
            tools: [{ type: 'function', function: { name: 'lookup' } }], rolloutId, onModel });
        for await (const _ of stream) { /* consume both requests */ }
        expect(fetch.mock.calls).toHaveLength(2);
        for (const [, init] of fetch.mock.calls) {
            expect(init.headers['X-Fusion-Rollout-Id']).toBe(rolloutId);
            expect(onModel).toHaveBeenCalledWith(JSON.parse(init.body).model);
        }
    });

    it('chatStreamEvents sends the header on the streaming request', async () => {
        globalThis.fetch = vi.fn(async () => streamResponse([
            { choices: [{ delta: { content: 'hi' } }] },
        ]));
        const events = chatStreamEvents({ messages: [{ role: 'user', content: 'hi' }], rolloutId: 'ro-abc1234567890abc' });
        for await (const part of events) expect(part.type).toBe('text');
        const headers = globalThis.fetch.mock.calls[0][1].headers;
        expect(headers['X-Fusion-Rollout-Id']).toBe('ro-abc1234567890abc');
    });
});
