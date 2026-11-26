import { afterEach, describe, expect, it, vi } from 'vitest';
import { isAsyncTool, runAsyncTool } from '../src/core/rollouts.js';

describe('grep_rollouts (#45/#47)', () => {
    afterEach(() => vi.unstubAllGlobals());

    it('is the only async tool', () => {
        expect(isAsyncTool('grep_rollouts')).toBe(true);
        expect(isAsyncTool('read_range')).toBe(false);
    });

    it('requires a query', async () => {
        const result = await runAsyncTool('grep_rollouts', {});
        expect(result.ok).toBe(false);
        expect(result.content).toContain('query is required');
    });

    it('returns parsed matches from office-api', async () => {
        const body = { matches: [{ line: 3, record: { rollout_id: 'ro-1' } }], truncated: false, exists: true };
        const fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve(body) });
        vi.stubGlobal('fetch', fetch);

        const result = await runAsyncTool('grep_rollouts', { query: 'ro-1', limit: 5 });

        expect(result.ok).toBe(true);
        expect(JSON.parse(result.content)).toEqual({ matches: body.matches, truncated: false, exists: true });
        expect(fetch).toHaveBeenCalledWith(
            expect.stringContaining('/v1/rollouts/grep?q=ro-1&limit=5'),
            expect.objectContaining({ signal: expect.anything() }),
        );
    });

    it('clamps the limit to 1-100 and defaults to 20', async () => {
        const fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({ matches: [] }) });
        vi.stubGlobal('fetch', fetch);

        await runAsyncTool('grep_rollouts', { query: 'x', limit: 500 });
        expect(fetch.mock.calls[0][0]).toContain('limit=100');

        await runAsyncTool('grep_rollouts', { query: 'x' });
        expect(fetch.mock.calls[1][0]).toContain('limit=20');
    });

    it('reports a refused lookup with the status', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
            ok: false,
            status: 422,
            json: () => Promise.resolve({ detail: 'invalid regex' }),
        }));

        const result = await runAsyncTool('grep_rollouts', { query: '(bad' });

        expect(result.ok).toBe(false);
        expect(result.content).toContain('422');
        expect(result.content).toContain('invalid regex');
    });

    it('answers actionable text when office-api is unreachable', async () => {
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));

        const result = await runAsyncTool('grep_rollouts', { query: 'deck' });

        expect(result.ok).toBe(false);
        expect(result.content).toContain('office-api is not reachable');
        expect(result.changed).toBe(false);
    });

    it('rejects unknown tool names', async () => {
        const result = await runAsyncTool('write_cells', {});
        expect(result.ok).toBe(false);
        expect(result.content).toContain('There is no tool called write_cells');
    });
});
