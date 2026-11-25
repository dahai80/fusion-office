// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createOutcomeReporter, newRolloutId, outcomeScore } from '../src/outcomes.js';

beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
    vi.restoreAllMocks();
});

const recordOf = (fetchImpl, call = 0) => JSON.parse(fetchImpl.mock.calls[call][1].body);

describe('outcome reporter', () => {
    it('posts one schema-v1 record with the signal and its default score', () => {
        const fetchImpl = vi.fn().mockResolvedValue({ ok: true });
        const reporter = createOutcomeReporter({ app: 'documents', fetchImpl });

        reporter.report({
            signal: 'user_accepted',
            detail: 'Replace selection',
            model: 'm-1',
            messages: [{ role: 'user', content: 'hello' }],
            rolloutId: 'ro-x:e1',
        });

        expect(fetchImpl).toHaveBeenCalledTimes(1);
        const [endpoint, init] = fetchImpl.mock.calls[0];
        expect(endpoint).toBe('http://127.0.0.1:11492/v1/outcomes');
        expect(init.method).toBe('POST');
        const record = JSON.parse(init.body);
        expect(record.schema_version).toBe(1);
        expect(record.rollout_id).toBe('ro-x:e1');
        expect(record.source).toBe('fusion-office/documents');
        expect(record.model).toBe('m-1');
        expect(record.outcome).toEqual({ signal: 'user_accepted', score: 1, detail: 'Replace selection' });
        expect(record.messages).toEqual([{ role: 'user', content: '[redacted:5]' }]);
    });

    it('is idempotent: a second report for the same rollout id is dropped', () => {
        const fetchImpl = vi.fn().mockResolvedValue({ ok: true });
        const reporter = createOutcomeReporter({ app: 'pm', fetchImpl });

        reporter.report({ signal: 'user_accepted', rolloutId: 'ro-x:e1' });
        reporter.report({ signal: 'user_accepted', rolloutId: 'ro-x:e1' });

        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('never blocks or throws: a failed POST is only logged', async () => {
        const fetchImpl = vi.fn().mockRejectedValue(new Error('sink down'));
        const reporter = createOutcomeReporter({ app: 'pdf', fetchImpl });

        expect(() => reporter.report({ signal: 'error', rolloutId: 'ro-x:e1' })).not.toThrow();
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('outcome report dropped'));
    });

    it('redacts message content by default, keeping the length', () => {
        const fetchImpl = vi.fn().mockResolvedValue({ ok: true });
        const reporter = createOutcomeReporter({ app: 'documents', fetchImpl });

        reporter.report({ signal: 'task_success', messages: [{ role: 'user', content: 'secret document text' }], rolloutId: 'ro-x:e1' });

        expect(recordOf(fetchImpl).messages[0].content).toBe('[redacted:20]');
    });

    it('keeps verbatim content in raw mode, capped', () => {
        const fetchImpl = vi.fn().mockResolvedValue({ ok: true });
        const reporter = createOutcomeReporter({ app: 'documents', fetchImpl, contentMode: 'raw' });

        reporter.report({ signal: 'task_success', messages: [{ role: 'user', content: 'a'.repeat(9000) }], rolloutId: 'ro-x:e1' });

        const content = recordOf(fetchImpl).messages[0].content;
        expect(content.startsWith('aaaa')).toBe(true);
        expect(content.endsWith('…')).toBe(true);
        expect(content.length).toBe(8001);
    });

    it('caps the transcript to the last 40 messages in redact mode', () => {
        const fetchImpl = vi.fn().mockResolvedValue({ ok: true });
        const reporter = createOutcomeReporter({ app: 'pm', fetchImpl });
        const messages = Array.from({ length: 60 }, (_, i) => ({ role: 'user', content: `m${i}` }));

        reporter.report({ signal: 'task_success', messages, rolloutId: 'ro-x:e1' });

        const sent = recordOf(fetchImpl).messages;
        expect(sent.length).toBe(40);
        expect(sent[0].content).toBe('[redacted:3]');
        expect(sent.at(-1).content).toBe('[redacted:3]');
    });

    it('drops an unknown signal with a warning and sends nothing', () => {
        const fetchImpl = vi.fn().mockResolvedValue({ ok: true });
        const reporter = createOutcomeReporter({ app: 'pm', fetchImpl });

        reporter.report({ signal: 'excellent', rolloutId: 'ro-x:e1' });

        expect(fetchImpl).not.toHaveBeenCalled();
        expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('unknown outcome signal'));
    });

    it('mints a rollout id when none is given and reports the signal scores', () => {
        const reporter = createOutcomeReporter({ app: 'pm', fetchImpl: null });
        const record = reporter.buildRecord({ signal: 'user_edited' });

        expect(record.rollout_id).toMatch(/^ro-[0-9a-f]{16}$/);
        expect(record.outcome.score).toBe(0.5);
        expect(outcomeScore('user_rejected')).toBe(0);
        expect(outcomeScore('nope')).toBeNull();
    });

    it('mints ids in the gateway shape', () => {
        expect(newRolloutId()).toMatch(/^ro-[0-9a-f]{16}$/);
    });
});
