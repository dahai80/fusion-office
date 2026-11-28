import { describe, expect, test } from 'vitest'
import { selectByExecution } from '../src/execution-selection.js'

const plan = (cells) => [{ name: 'write_cells', input: { cells } }]
const mk = (ref, value) => ({ ref, value })

function cloneState(cells) {
    return { cells: cells.map((c) => ({ ...c })) }
}

// A sandbox that replays the candidate's writes over a fixed snapshot.
function replaySandbox(snapshot) {
    return {
        apply: async (candidate) => {
            const state = cloneState(snapshot)
            for (const call of candidate.calls || []) {
                if (call.name !== 'write_cells') throw new Error('unsupported-tool')
                for (const { ref, value } of call.input.cells) {
                    const cell = state.cells.find((c) => c.ref === ref)
                    if (!cell) throw new Error('unknown-ref ' + ref)
                    cell.value = value
                }
            }
            return state
        },
    }
}

describe('execution-level selection (#68)', () => {
    const snapshot = [mk('A1', 0), mk('B1', 0)]

    test('agreement keeps the greedy choice', async () => {
        const candidates = [{ calls: plan([mk('A1', 7)]) }, { calls: plan([mk('A1', 7)]) }]
        const record = await selectByExecution({
            candidates,
            sandbox: replaySandbox(snapshot),
            graders: { score: (state) => (state.cells.find((c) => c.ref === 'A1').value === 7 ? 1 : 0) },
        })
        expect(record.chosen).toBe(0)
        expect(record.plan_agreement).toBe(true)
        expect(record.exec_grade).toBe(1)
        expect(record.sandbox_failures).toBe(0)
    })

    test('disagreement: the higher-graded candidate wins over the greedy plan', async () => {
        // Greedy writes a value the grader penalizes (out-of-range); a
        // resample writes the well-formed one and must be selected.
        const candidates = [
            { calls: plan([mk('A1', 999)]) },
            { calls: plan([mk('A1', 42)]) },
        ]
        const record = await selectByExecution({
            candidates,
            sandbox: replaySandbox(snapshot),
            graders: { score: (state) => { const v = state.cells.find((c) => c.ref === 'A1').value; return v >= 0 && v <= 100 ? 1 : 0 } },
        })
        expect(record.chosen).toBe(1)
        expect(record.exec_grade).toBe(1)
        expect(record.plan_agreement).toBe(false)
    })

    test('grade tie is broken by plan agreement: the greedy-signature resample beats the singleton', async () => {
        // The greedy plan fails its sandbox run; its signature survives in a
        // resample (2 of 3 candidates agree). At equal grade the shared-
        // signature candidate must beat the singleton.
        const candidates = [
            { calls: plan([mk('Z9', 1)]) },
            { calls: plan([mk('A1', 1)]) },
            { calls: plan([mk('A1', 2)]) },
        ]
        const record = await selectByExecution({
            candidates,
            sandbox: replaySandbox(snapshot),
            graders: { score: () => 0.5 },
        })
        expect(record.candidates[0].error).toContain('unknown-ref')
        expect(record.chosen).toBe(1)
    })

    test('full tie with the greedy plan runnable keeps the greedy choice', async () => {
        const candidates = [
            { calls: plan([mk('A1', 1)]) },
            { calls: plan([mk('A1', 2)]) },
            { calls: plan([mk('A1', 1)]) },
        ]
        const record = await selectByExecution({
            candidates,
            sandbox: replaySandbox(snapshot),
            graders: { score: () => 0.5 },
        })
        expect(record.chosen).toBe(0)
    })

    test('sandbox failure on one candidate excludes it, others still compete', async () => {
        const candidates = [
            { calls: plan([mk('A1', 5)]) },
            { calls: [{ name: 'manage_sheet', input: {} }] },
            { calls: plan([mk('A1', 6)]) },
        ]
        const record = await selectByExecution({
            candidates,
            sandbox: replaySandbox(snapshot),
            graders: { score: (state) => (state.cells.find((c) => c.ref === 'A1').value > 5 ? 1 : 0) },
        })
        expect(record.candidates[1].error).toContain('unsupported-tool')
        expect(record.candidates[1].grade).toBe(null)
        expect(record.sandbox_failures).toBe(1)
        expect(record.chosen).toBe(2)
    })

    test('every sandbox failing degrades to the greedy plan with a null grade (fail-soft)', async () => {
        const candidates = [{ calls: plan([mk('Z9', 1)]) }, { calls: plan([mk('Z9', 2)]) }]
        const record = await selectByExecution({
            candidates,
            sandbox: replaySandbox(snapshot),
            graders: { score: () => 1 },
        })
        expect(record.exec_grade).toBe(null)
        expect(record.chosen).toBe(0)
        expect(record.sandbox_failures).toBe(2)
    })

    test('stop before any grade returns null; grades are clamped to [0,1]', async () => {
        const stopped = Promise.resolve(true)
        expect(await selectByExecution({
            candidates: [{ calls: plan([mk('A1', 1)]) }],
            sandbox: replaySandbox(snapshot),
            graders: { score: () => 1 },
            stopped,
        })).toBe(null)

        const record = await selectByExecution({
            candidates: [{ calls: plan([mk('A1', 5)]) }],
            sandbox: replaySandbox(snapshot),
            graders: { score: () => 42 },
        })
        expect(record.exec_grade).toBe(1)
    })

    test('missing sandbox or graders throw (misconfiguration is loud, not silent)', async () => {
        await expect(selectByExecution({ candidates: [{ calls: [] }], graders: { score: () => 1 } })).rejects.toThrow('sandbox-apply-required')
        await expect(selectByExecution({ candidates: [{ calls: [] }], sandbox: replaySandbox(snapshot) })).rejects.toThrow('graders-score-required')
    })
})
