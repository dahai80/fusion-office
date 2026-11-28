import { describe, it, expect } from 'vitest';
import { argSignature, planSignature, sampleToolPlan, consistencyVerdict } from '../src/consistency.js';

describe('argSignature', () => {
    it('ignores key order', () => {
        expect(argSignature({ a: 1, b: 2 })).toBe(argSignature({ b: 2, a: 1 }));
    });

    it('distinguishes different values and is stable for missing args', () => {
        expect(argSignature({ a: 1 })).not.toBe(argSignature({ a: 2 }));
        expect(argSignature(undefined)).toBe(argSignature({}));
    });

    it('treats a numeric string and its number as the same value (#61)', () => {
        expect(argSignature({ value: 42 })).toBe(argSignature({ value: '42' }));
        expect(argSignature({ value: ' 42 ' })).toBe(argSignature({ value: 42 }));
        expect(argSignature({ a: 1 })).not.toBe(argSignature({ a: '1x' }));
    });

    it('treats formula values with an optional leading = as the same (#61)', () => {
        expect(argSignature({ value: '=A1*2' })).toBe(argSignature({ value: 'A1*2' }));
        expect(argSignature({ value: '==A1*2' })).toBe(argSignature({ value: 'A1*2' }));
        expect(argSignature({ value: '=42' })).toBe(argSignature({ value: 42 }));
        expect(argSignature({ text: '=A1*2' })).not.toBe(argSignature({ text: '=B1*2' }));
    });
});

describe('planSignature', () => {
    it('ignores call order and call ids', () => {
        const a = [
            { id: 'c1', name: 'read_document', input: { scope: 'document' } },
            { id: 'c2', name: 'insert_text', input: { text: 'hi', where: 'start' } },
        ];
        const b = [
            { id: 'c9', name: 'insert_text', input: { where: 'start', text: 'hi' } },
            { id: 'c8', name: 'read_document', input: { scope: 'document' } },
        ];
        expect(planSignature(a)).toBe(planSignature(b));
    });

    it('distinguishes different plans', () => {
        expect(planSignature([{ name: 'insert_text', input: { text: 'a' } }]))
            .not.toBe(planSignature([{ name: 'insert_text', input: { text: 'b' } }]));
        expect(planSignature(null)).toBe('[]');
    });
});

const streamOf = (parts) => async function* () { yield* parts; };
const never = new Promise(() => {});

describe('sampleToolPlan', () => {
    it('collects only the tool calls from a stream', async () => {
        const sample = await sampleToolPlan(
            () => streamOf([{ type: 'text', text: 'Doing it.' }, { type: 'tool', id: 'c1', name: 'insert_text', input: { text: 'hi' } }])(),
            [],
            {},
            never,
        );
        expect(sample).toEqual({ stopped: false, calls: [{ id: '', name: 'insert_text', input: { text: 'hi' } }] });
    });

    it('returns no candidate when the stream fails and honors a stop', async () => {
        const failed = await sampleToolPlan(() => { throw new Error('gateway down'); }, [], {}, never);
        expect(failed).toEqual({ stopped: false, calls: null });
        const stopped = await sampleToolPlan(streamOf([{ type: 'tool', id: 'c1', name: 'x', input: {} }]), [], {}, Promise.resolve(true));
        expect(stopped).toEqual({ stopped: true, calls: null });
    });
});

describe('consistencyVerdict', () => {
    const greedy = [{ id: 'c1', name: 'write_cells', input: { region: 'A1:B2', values: [[1, 2]] } }];

    it('returns null with no valid extra sample', () => {
        expect(consistencyVerdict(greedy, [])).toBeNull();
        expect(consistencyVerdict(greedy, [{ stopped: false, calls: null }])).toBeNull();
    });

    it('agrees when every sample proposes the same plan', () => {
        const same = { stopped: false, calls: [{ id: 'z', name: 'write_cells', input: { values: [[1, 2]], region: 'A1:B2' } }] };
        expect(consistencyVerdict(greedy, [same, same])).toEqual({ samples: 2, agreement: true, agreeCount: 2 });
    });

    it('records disagreement when a sample proposes a different plan', () => {
        const other = { stopped: false, calls: [{ id: 'z', name: 'write_cells', input: { region: 'C1:D2', values: [[1, 2]] } }] };
        expect(consistencyVerdict(greedy, [other])).toEqual({ samples: 1, agreement: false, agreeCount: 0 });
    });

    it('agrees across benign type and formula-prefix drift (#61)', () => {
        const greedy = [{ id: 'c1', name: 'write_cells', input: { cells: [{ ref: 'A1', value: 42 }, { ref: 'B1', value: '=A1*2' }] } }];
        const drifted = {
            stopped: false,
            calls: [{ id: 'z', name: 'write_cells', input: { cells: [{ ref: 'A1', value: '42' }, { ref: 'B1', value: 'A1*2' }] } }],
        };
        expect(consistencyVerdict(greedy, [drifted])).toEqual({ samples: 1, agreement: true, agreeCount: 1 });
    });
});
