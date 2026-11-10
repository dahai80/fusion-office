import { describe, it, expect, afterEach, vi } from 'vitest';
import { configure, chatStreamEvents } from '../src/index.js';

configure({ baseUrl: 'http://gateway.test', apiKey: 'k', defaultModel: 'm' });

function sseResponse(chunks, gapMs, signal) {
    const encoder = new TextEncoder();
    // A waiting gap rejects when the caller aborts, the way a real fetch body reader does.
    const sleep = (ms) => new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
    });
    const body = new ReadableStream({
        async start(controller) {
            for (const chunk of chunks) {
                await sleep(gapMs);
                controller.enqueue(encoder.encode('data: ' + JSON.stringify(chunk) + '\n\n'));
            }
            controller.close();
        },
    });
    return new Response(body, { status: 200 });
}

const textChunk = (t) => ({ choices: [{ delta: { content: t } }] });

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('chatStreamEvents idle timeout', () => {
    it('keeps streaming past the idle limit while chunks keep arriving', async () => {
        // Eight chunks 60ms apart outlast a 150ms idle limit several times over.
        vi.stubGlobal('fetch', vi.fn(async (url, init) => sseResponse(Array.from({ length: 8 }, (_, i) => textChunk(String(i))), 60, init.signal)));
        let text = '';
        for await (const part of chatStreamEvents({ messages: [{ role: 'user', content: 'hi' }], timeoutMs: 150 })) {
            if (part.type === 'text') text += part.text;
        }
        expect(text).toBe('01234567');
    });

    it('aborts when the stream goes silent past the idle limit', async () => {
        vi.stubGlobal('fetch', vi.fn(async (url, init) => sseResponse([textChunk('a'), textChunk('b')], 500, init.signal)));
        const parts = [];
        await expect(async () => {
            for await (const part of chatStreamEvents({ messages: [{ role: 'user', content: 'hi' }], timeoutMs: 100 })) {
                parts.push(part);
            }
        }).rejects.toThrow();
        expect(parts.length).toBeLessThan(2);
    });

    it('aborts even when keepalive comments keep arriving without real events (#26)', async () => {
        const encoder = new TextEncoder();
        const abort = new AbortController();
        const sleep = (ms) => new Promise((resolve, reject) => {
            const timer = setTimeout(resolve, ms);
            abort.signal.addEventListener('abort', () => { clearTimeout(timer); reject(abort.signal.reason); }, { once: true });
        });
        const body = new ReadableStream({
            async start(controller) {
                // Keepalive comments every 40ms, forever from the stream's side: only the
                // caller's idle timer ends this. Real events never come.
                abort.signal.addEventListener('abort', () => controller.error(abort.signal.reason), { once: true });
                try {
                    for (;;) {
                        await sleep(40);
                        controller.enqueue(encoder.encode(': ping\n\n'));
                    }
                } catch { /* errored by the abort listener */ }
            },
        });
        vi.stubGlobal('fetch', vi.fn(async (url, init) => {
            init.signal.addEventListener('abort', () => abort.abort(), { once: true });
            return new Response(body, { status: 200 });
        }));
        await expect(async () => {
            for await (const part of chatStreamEvents({ messages: [{ role: 'user', content: 'hi' }], timeoutMs: 150 })) {
                void part;
            }
        }).rejects.toThrow();
    });
});
