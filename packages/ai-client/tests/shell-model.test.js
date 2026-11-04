// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';

import { inShell, shellModel, chat, configure, baseUrlFor } from '../src/index.js';
import { createModelPicker } from '../src/model-picker.js';

// jsdom 27 ships no localStorage; these tests only need get/set/remove/clear.
beforeAll(() => {
    const store = new Map();
    globalThis.localStorage = {
        getItem: key => (store.has(key) ? store.get(key) : null),
        setItem: (key, value) => store.set(key, String(value)),
        removeItem: key => store.delete(key),
        clear: () => store.clear(),
    };
});

const at = (path) => window.history.replaceState(null, '', path);

describe('shell model preference', () => {
    beforeEach(() => {
        at('/office/documents/');
        localStorage.clear();
    });

    it('reads nothing outside the shell, even when the key exists', () => {
        localStorage.setItem('fusion.shell.model', 'shell-model');
        expect(inShell()).toBe(false);
        expect(shellModel()).toBe('');
    });

    it('reads the handoff key inside the shell and treats empty as unset', () => {
        at('/shell/fusion-office-documents/');
        expect(inShell()).toBe(true);
        expect(shellModel()).toBe('');
        localStorage.setItem('fusion.shell.model', 'shell-model');
        expect(shellModel()).toBe('shell-model');
        localStorage.setItem('fusion.shell.model', '');
        expect(shellModel()).toBe('');
    });

    it('resolves module override > shell pref > env default', async () => {
        at('/shell/fusion-office-documents/');
        localStorage.setItem('fusion.shell.model', 'shell-model');
        configure({ baseUrl: 'http://gw.test', apiKey: 'k', defaultModel: 'env-model' });
        const bodies = [];
        const realFetch = globalThis.fetch;
        globalThis.fetch = async (_url, init) => {
            bodies.push(JSON.parse(init.body));
            return { ok: true, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) };
        };
        try {
            await chat({ messages: [{ role: 'user', content: 'hi' }] });
            await chat({ messages: [{ role: 'user', content: 'hi' }], model: 'explicit-model' });
            localStorage.setItem('fusion-office.ai-model', 'picked-model');
            await chat({ messages: [{ role: 'user', content: 'hi' }] });
        } finally {
            globalThis.fetch = realFetch;
        }
        expect(bodies.map(b => b.model)).toEqual(['shell-model', 'explicit-model', 'picked-model']);
    });

    it('stays on the env default outside the shell', async () => {
        configure({ baseUrl: 'http://gw.test', apiKey: 'k', defaultModel: 'env-model' });
        localStorage.setItem('fusion.shell.model', 'shell-model');
        const bodies = [];
        const realFetch = globalThis.fetch;
        globalThis.fetch = async (_url, init) => {
            bodies.push(JSON.parse(init.body));
            return { ok: true, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) };
        };
        try {
            await chat({ messages: [{ role: 'user', content: 'hi' }] });
        } finally {
            globalThis.fetch = realFetch;
        }
        expect(bodies[0].model).toBe('env-model');
    });

    it('prefills the picker with the shell pref when no per-app choice exists', async () => {
        at('/shell/fusion-office-documents/');
        localStorage.setItem('fusion.shell.model', 'shell-model');
        const node = createModelPicker({}, {
            isConfigured: () => true,
            listModels: async () => [{ id: 'local-9b', loaded: true }],
            getConfig: () => ({ defaultModel: 'env-model' }),
            logError: vi.fn(),
        });
        await Promise.resolve();
        await Promise.resolve();
        expect(node.value).toBe('shell-model');
        expect([...node.options].map(o => o.value)).toContain('shell-model');
    });

    it('keeps the per-app choice ahead of the shell pref in the picker', async () => {
        at('/shell/fusion-office-documents/');
        localStorage.setItem('fusion.shell.model', 'shell-model');
        localStorage.setItem('fusion-office.ai-model', 'picked-model');
        const node = createModelPicker({}, {
            isConfigured: () => true,
            listModels: async () => [{ id: 'local-9b', loaded: true }],
            getConfig: () => ({ defaultModel: 'env-model' }),
            logError: vi.fn(),
        });
        await Promise.resolve();
        await Promise.resolve();
        expect(node.value).toBe('picked-model');
    });
});

describe('base URL relay', () => {
    it('relays through /__fusion_gateway on the fixed office ports', () => {
        configure({ baseUrl: 'http://gw.test', apiKey: 'k', defaultModel: 'm' });
        expect(baseUrlFor({ port: '11485' })).toBe('/__fusion_gateway');
        expect(baseUrlFor({ port: '11489' })).toBe('/__fusion_gateway');
    });

    it('keeps the configured base on any other port and without a location', () => {
        configure({ baseUrl: 'http://gw.test', apiKey: 'k', defaultModel: 'm' });
        expect(baseUrlFor({ port: '5189' })).toBe('http://gw.test');
        expect(baseUrlFor({ port: '' })).toBe('http://gw.test');
        expect(baseUrlFor(null)).toBe('http://gw.test');
    });
});
