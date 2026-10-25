// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { getSelectedModel, setSelectedModel } from '../src/model-picker.js';

import { createModelPicker } from '../src/model-picker.js';

// jsdom 27 ships no localStorage; the picker only needs get/set/remove/clear.
beforeAll(() => {
    const store = new Map();
    globalThis.localStorage = {
        getItem: key => (store.has(key) ? store.get(key) : null),
        setItem: (key, value) => store.set(key, String(value)),
        removeItem: key => store.delete(key),
        clear: () => store.clear(),
    };
});

const pickerWith = (models, { configured = true, fallback = 'default-model' } = {}) => {
    const state = { change: null };
    const logError = vi.fn();
    const select = createModelPicker(
        { onChange: id => { state.change = id; } },
        {
            isConfigured: () => configured,
            listModels: async () => models,
            getConfig: () => ({ defaultModel: fallback }),
            logError,
        },
    );
    return { select, state, logError };
};

describe('model picker', () => {
    beforeEach(() => {
        localStorage.clear();
    });

    it('keeps the chosen model across calls and reloads', () => {
        expect(getSelectedModel()).toBe('');
        setSelectedModel('glm-5');
        expect(getSelectedModel()).toBe('glm-5');
        setSelectedModel('');
        expect(getSelectedModel()).toBe('');
    });

    it('returns null when AI is not configured', async () => {
        const { select } = pickerWith([], { configured: false });
        expect(await select).toBeNull();
    });

    it('lists gateway models, loaded first, and remembers the choice', async () => {
        const { select, state } = pickerWith([
            { id: 'qwen-remote', loaded: false },
            { id: 'local-9b', loaded: true },
        ]);
        const node = await select;
        await Promise.resolve();
        const ids = [...node.options].map(o => o.value);
        expect(ids).toEqual(['local-9b', 'default-model', 'qwen-remote']);
        expect(node.value).toBe('local-9b');
        node.value = 'qwen-remote';
        node.dispatchEvent(new Event('change'));
        expect(getSelectedModel()).toBe('qwen-remote');
        expect(state.change).toBe('qwen-remote');
    });

    it('always offers the fallback and a stored model the gateway did not list', async () => {
        setSelectedModel('gone-model');
        const { select } = pickerWith([{ id: 'local-9b', loaded: true }], { fallback: 'default-model' });
        const node = await select;
        const ids = [...node.options].map(o => o.value);
        expect(ids).toEqual(expect.arrayContaining(['gone-model', 'default-model', 'local-9b']));
        expect(node.value).toBe('gone-model');
    });

    it('keeps the fallback list when the gateway cannot be reached', async () => {
        const logError = vi.fn();
        const node = createModelPicker({}, {
            isConfigured: () => true,
            listModels: async () => { throw new Error('gateway 503'); },
            getConfig: () => ({ defaultModel: 'default-model' }),
            logError,
        });
        await Promise.resolve();
        await Promise.resolve();
        expect([...node.options].map(o => o.value)).toEqual(['default-model']);
        expect(logError).toHaveBeenCalled();
    });
});
