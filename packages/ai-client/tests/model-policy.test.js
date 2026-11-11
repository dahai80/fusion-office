// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';

import { moduleFromPath, parseModelPolicy, applyPolicyToModels, fetchModelPolicy } from '../src/model-policy.js';
import { chat, listModels, isConfigured, configure, resetPolicyCache, resetStaticKeyWarning } from '../src/index.js';

// jsdom 27 ships no localStorage; the chain reads the picker and shell keys.
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

const POLICY = {
    resolved_model: 'policy-model',
    source: 'tenant_default',
    privacy_mode: '',
    privacy_filtered: false,
    allowlist: null,
};

describe('moduleFromPath', () => {
    it('reads the module id from a shell pathname', () => {
        expect(moduleFromPath('/shell/fusion-office-documents/')).toBe('fusion-office-documents');
        expect(moduleFromPath('/shell/fusion-office-pm/index.html')).toBe('fusion-office-pm');
    });

    it('reads nothing outside the shell and handles encoded ids', () => {
        expect(moduleFromPath('/office/documents/')).toBe('');
        expect(moduleFromPath('/')).toBe('');
        expect(moduleFromPath(null)).toBe('');
        expect(moduleFromPath('/shell/fusion-office%2Dpm/')).toBe('fusion-office-pm');
    });
});

describe('parseModelPolicy', () => {
    it('maps the gateway response fields', () => {
        const policy = parseModelPolicy(POLICY);
        expect(policy).toEqual({
            resolvedModel: 'policy-model',
            source: 'tenant_default',
            privacyMode: '',
            privacyFiltered: false,
            allowlist: null,
        });
    });

    it('keeps an allowlist-only response and drops garbage', () => {
        expect(parseModelPolicy({ allowlist: ['a', 3, 'b'] })).toEqual({
            resolvedModel: '', source: '', privacyMode: '', privacyFiltered: false, allowlist: ['a', 'b'],
        });
        expect(parseModelPolicy(null)).toBeNull();
        expect(parseModelPolicy({ source: 'x' })).toBeNull();
        expect(parseModelPolicy('nope')).toBeNull();
    });
});

describe('applyPolicyToModels', () => {
    const models = [
        { id: 'mlx-community/Qwen3.8-27B-8bit', loaded: true },
        { id: 'mlx-community/other', loaded: false },
        { id: 'cloud/glm', loaded: false },
    ];

    it('passes models through when there is no policy', () => {
        expect(applyPolicyToModels(models, null)).toBe(models);
        expect(applyPolicyToModels([], {})).toEqual([]);
    });

    it('filters by the allowlist', () => {
        const allowed = applyPolicyToModels(models, { allowlist: ['cloud/glm'] });
        expect(allowed.map(m => m.id)).toEqual(['cloud/glm']);
    });

    it('a policy without an allowlist offers nothing, local_only included (fail-closed)', () => {
        expect(applyPolicyToModels(models, { privacyMode: 'local_only', allowlist: null })).toEqual([]);
    });

    it('never falls back to the catalog for an allowlist: missing entries surface as unloaded options (issue #13)', () => {
        const kept = applyPolicyToModels(models, { allowlist: ['local-only-model'] });
        expect(kept).toEqual([{ id: 'local-only-model', loaded: false }]);
    });

    it('keeps allowlisted catalog hits ahead of missing entries (issue #13)', () => {
        const kept = applyPolicyToModels(models, { allowlist: ['cloud/glm', 'local-only-model'] });
        expect(kept.map(m => m.id)).toEqual(['cloud/glm', 'local-only-model']);
        expect(kept[0].loaded).toBe(false);
        expect(kept[1].loaded).toBe(false);
    });
});

describe('fetchModelPolicy', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('parses a gateway response and passes the module query', async () => {
        const calls = [];
        const fetchImpl = async (url, init) => {
            calls.push({ url, init });
            return { ok: true, json: async () => POLICY };
        };
        const policy = await fetchModelPolicy({ baseUrl: '', headers: { Authorization: 'Bearer k' }, moduleId: 'fusion-office-documents', fetchImpl });
        expect(policy.resolvedModel).toBe('policy-model');
        expect(calls[0].url).toBe('/api/v1/shell/model-policy?module=fusion-office-documents');
        expect(calls[0].init.headers.Authorization).toBe('Bearer k');
    });

    it('returns null on a non-ok response, a bad body, or a fetch failure', async () => {
        expect(await fetchModelPolicy({ fetchImpl: async () => ({ ok: false, status: 401 }) })).toBeNull();
        expect(await fetchModelPolicy({ fetchImpl: async () => ({ ok: true, json: async () => ({ source: 'x' }) }) })).toBeNull();
        expect(await fetchModelPolicy({ fetchImpl: async () => { throw new Error('down'); } })).toBeNull();
    });

    it('aborts a slow gateway and returns null', async () => {
        vi.useFakeTimers();
        const fetchImpl = (_url, init) => new Promise((resolve, reject) => {
            init.signal.addEventListener('abort', () => reject(new Error('aborted')));
        });
        const pending = fetchModelPolicy({ timeoutMs: 20, fetchImpl });
        const result = await vi.waitFor(() => {
            vi.advanceTimersByTime(30);
            return pending;
        });
        expect(result).toBeNull();
    });
});

describe('policy in the model chain', () => {
    beforeEach(() => {
        at('/shell/fusion-office-documents/');
        localStorage.clear();
        resetPolicyCache();
        configure({ baseUrl: 'http://gw.test', apiKey: 'k', defaultModel: 'env-model' });
    });

    afterEach(() => {
        resetPolicyCache();
    });

    const mockGateway = (policyBodies) => {
        const state = { policyFetches: 0, bodies: [] };
        const realFetch = globalThis.fetch;
        globalThis.fetch = async (url, init) => {
            if (String(url).includes('/api/v1/shell/model-policy')) {
                state.policyFetches++;
                return { ok: true, json: async () => policyBodies(state.policyFetches) };
            }
            state.bodies.push(JSON.parse(init.body));
            return { ok: true, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) };
        };
        return { state, restore: () => { globalThis.fetch = realFetch; } };
    };

    it('uses the policy-resolved model when nothing earlier in the chain is set', async () => {
        const ALLOWED = { ...POLICY, allowlist: ['policy-model'] };
        const gw = mockGateway(() => ALLOWED);
        try {
            await chat({ messages: [{ role: 'user', content: 'hi' }] });
        } finally {
            gw.restore();
        }
        expect(gw.state.bodies[0].model).toBe('policy-model');
    });

    it('offers no model when the policy carries no allowlist (fail-closed)', async () => {
        const gw = mockGateway(() => POLICY);
        try {
            // Issue #28: fail-closed no longer sends model: "" — it fails
            // before the request, in words a customer can act on.
            await expect(chat({ messages: [{ role: 'user', content: 'hi' }] }))
                .rejects.toThrow('No AI model is available for this app');
        } finally {
            gw.restore();
        }
        expect(gw.state.bodies).toEqual([]);
    });

    it('keeps explicit model, per-app pick, and shell pref ahead of the policy', async () => {
        const ALLOWED = { ...POLICY, allowlist: ['policy-model', 'picked-model', 'shell-model'] };
        const gw = mockGateway(() => ALLOWED);
        try {
            await chat({ messages: [{ role: 'user', content: 'hi' }], model: 'explicit-model' });
            localStorage.setItem('fusion-office.ai-model', 'picked-model');
            await chat({ messages: [{ role: 'user', content: 'hi' }] });
            localStorage.removeItem('fusion-office.ai-model');
            localStorage.setItem('fusion.shell.model', 'shell-model');
            await chat({ messages: [{ role: 'user', content: 'hi' }] });
        } finally {
            gw.restore();
        }
        expect(gw.state.bodies.map(b => b.model)).toEqual(['explicit-model', 'picked-model', 'shell-model']);
        // The explicit-model call and pick chain never needed the policy.
        expect(gw.state.policyFetches).toBeLessThanOrEqual(2);
    });

    it('clamps a stored pick outside the tenant allowlist to the policy model (issue #14)', async () => {
        const ALLOW = { ...POLICY, allowlist: ['policy-model'] };
        const gw = mockGateway(() => ALLOW);
        try {
            localStorage.setItem('fusion-office.ai-model', 'picked-model');
            await chat({ messages: [{ role: 'user', content: 'hi' }] });
            expect(gw.state.bodies[0].model).toBe('policy-model');
            localStorage.setItem('fusion-office.ai-model', 'policy-model');
            await chat({ messages: [{ role: 'user', content: 'hi' }] });
            expect(gw.state.bodies[1].model).toBe('policy-model');
            localStorage.removeItem('fusion-office.ai-model');
        } finally {
            gw.restore();
        }
    });

    it('clamps the build-time default and passes explicit models through (issue #14)', async () => {
        const ALLOW = { resolved_model: '', source: 'tenant_default', privacy_mode: '', privacy_filtered: false, allowlist: ['tenant-only-model'] };
        const gw = mockGateway(() => ALLOW);
        try {
            await chat({ messages: [{ role: 'user', content: 'hi' }] });
            expect(gw.state.bodies[0].model).toBe('tenant-only-model');
            await chat({ messages: [{ role: 'user', content: 'hi' }], model: 'explicit-model' });
            expect(gw.state.bodies[1].model).toBe('explicit-model');
        } finally {
            gw.restore();
        }
    });

    it('caches the policy across calls and skips the fetch outside the shell', async () => {
        const gw = mockGateway(() => POLICY);
        try {
            await chat({ model: 'policy-model', messages: [{ role: 'user', content: 'hi' }] });
            await chat({ model: 'policy-model', messages: [{ role: 'user', content: 'hi' }] });
            expect(gw.state.policyFetches).toBe(1);
            resetPolicyCache();
            at('/office/documents/');
            configure({ baseUrl: 'http://gw.test', apiKey: 'k', defaultModel: 'env-model' });
            await chat({ messages: [{ role: 'user', content: 'hi' }] });
            expect(gw.state.bodies[2].model).toBe('env-model');
            expect(gw.state.policyFetches).toBe(1);
        } finally {
            gw.restore();
        }
    });

    it('routes shell calls through the session-gated endpoints with no key header', async () => {
        const calls = [];
        const realFetch = globalThis.fetch;
        globalThis.fetch = async (url, init) => {
            calls.push({ url: String(url), init: init || {} });
            if (String(url).includes('model-policy')) return { ok: true, json: async () => POLICY };
            return { ok: true, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) };
        };
        try {
            await chat({ model: 'policy-model', messages: [{ role: 'user', content: 'hi' }] });
            await listModels();
        } finally {
            globalThis.fetch = realFetch;
        }
        expect(calls.some(c => c.url.endsWith('/api/v1/shell/chat/completions'))).toBe(true);
        expect(calls.some(c => c.url.endsWith('/api/v1/shell/models'))).toBe(true);
        const chatCall = calls.find(c => c.url.includes('chat/completions'));
        expect(chatCall.init.credentials).toBe('include');
        expect(chatCall.init.headers.Authorization).toBeUndefined();
    });

    it('keeps the static-key /v1 path with the key header outside the shell', async () => {
        resetStaticKeyWarning();
        const calls = [];
        const realFetch = globalThis.fetch;
        globalThis.fetch = async (url, init) => {
            calls.push({ url: String(url), init: init || {} });
            return { ok: true, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) };
        };
        try {
            at('/office/documents/');
            configure({ baseUrl: 'http://gw.test', apiKey: 'k', defaultModel: 'env-model' });
            await chat({ messages: [{ role: 'user', content: 'hi' }] });
            await chat({ messages: [{ role: 'user', content: 'hi' }] });
        } finally {
            globalThis.fetch = realFetch;
        }
        const chatCalls = calls.filter(c => c.url.includes('chat/completions'));
        expect(chatCalls[0].url.endsWith('/v1/chat/completions')).toBe(true);
        expect(chatCalls[0].init.headers.Authorization).toBe('Bearer k');
    });

    it('reports configured inside the shell without a baked key', () => {
        at('/shell/fusion-office-documents/');
        configure({ baseUrl: 'http://gw.test', apiKey: '', defaultModel: 'env-model' });
        expect(isConfigured()).toBe(true);
        at('/office/documents/');
        expect(isConfigured()).toBe(false);
    });

    it('offers no model when the gateway rejects the policy (fail-closed)', async () => {
        const realFetch = globalThis.fetch;
        const bodies = [];
        globalThis.fetch = async (url, init) => {
            if (String(url).includes('/api/v1/shell/model-policy')) return { ok: false, status: 401 };
            bodies.push(JSON.parse(init.body));
            return { ok: true, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) };
        };
        try {
            // Issue #28: fail-closed no longer sends model: "" — it fails
            // before the request, in words a customer can act on.
            await expect(chat({ messages: [{ role: 'user', content: 'hi' }] }))
                .rejects.toThrow('No AI model is available for this app');
        } finally {
            globalThis.fetch = realFetch;
        }
        expect(bodies).toEqual([]);
    });
});
