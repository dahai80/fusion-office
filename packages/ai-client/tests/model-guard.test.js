// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { chat, chatStreamEvents, configure, resetPolicyCache, resetStaticKeyWarning } from '../src/index.js';
import { setSelectedModel } from '../src/model-picker.js';

beforeEach(() => {
    resetPolicyCache();
    resetStaticKeyWarning();
    setSelectedModel('');
    // No stored pick, no shell preference, no build default: the resolution
    // chain has nothing to send, which is exactly the issue #28 case.
    configure({ defaultModel: '' });
    globalThis.fetch = vi.fn(async () => { throw new Error('fetch must not be reached'); });
});

describe('empty-model guard (issue #28)', () => {
    it('chat fails in customer words before any request leaves', async () => {
        await expect(chat({ messages: [{ role: 'user', content: 'hi' }] }))
            .rejects.toThrow('No AI model is available for this app. Ask your administrator to allow a model for it in the AI settings.');
        expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('chatStreamEvents fails the same way', async () => {
        await expect(chatStreamEvents({ messages: [{ role: 'user', content: 'hi' }] }).next())
            .rejects.toThrow('No AI model is available');
        expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('a request with an explicit model still goes out', async () => {
        globalThis.fetch = vi.fn(async () => ({
            ok: true,
            json: async () => ({ choices: [{ message: { content: 'ok' } }] }),
        }));
        const text = await chat({ model: 'glm-5', messages: [{ role: 'user', content: 'hi' }] });
        expect(text).toBe('ok');
        const body = JSON.parse(globalThis.fetch.mock.calls[0][1].body);
        expect(body.model).toBe('glm-5');
    });
});
