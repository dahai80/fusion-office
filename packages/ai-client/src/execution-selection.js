import { log } from './log.js'
import { planSignature } from './consistency.js'

// Issue #68 (RFC #64): execution-level consistency selection. Upgrades the
// plan-signature verdict of #57/#58: every candidate plan (the greedy round
// plus its temperature resamples) is applied to an isolated sandbox of the
// workspace — never the live document — and the resulting states are graded
// with structural checks. Selection picks the highest-graded candidate;
// plan agreement (#58) is the tiebreaker signal, not the only one.

/**
 * Grade and select among candidate plans.
 *
 * candidates  [{ calls }] — index 0 must be the greedy plan the turn would
 *             otherwise execute.
 * sandbox     { apply(candidate) -> state } — one isolated snapshot per
 *             call; must not touch the live document. A throw excludes the
 *             candidate and is recorded (fail-soft).
 * graders     { score(state, candidate) -> number } — structural checks in
 *             [0, 1] from the office-bench validator family (fidelity
 *             anchors, no-mutation, target-surface checks).
 * stopped     optional promise resolving to true to abort selection; the
 *             greedy plan then executes ungraded.
 *
 * Returns the unified selection record, or null when stopped before any
 * candidate ran. `exec_grade` is null when no candidate could be graded
 * (every sandbox failed): the caller executes the greedy plan and reports
 * the plan-level agreement only.
 */
export async function selectByExecution({ candidates, sandbox, graders, stopped }) {
    if (!candidates || !candidates.length) return null
    if (!sandbox || typeof sandbox.apply !== 'function') throw new Error('sandbox-apply-required')
    if (!graders || typeof graders.score !== 'function') throw new Error('graders-score-required')

    const graded = []
    const sigs = candidates.map((c) => planSignature(c.calls))
    for (let i = 0; i < candidates.length; i++) {
        if (stopped && (await Promise.race([stopped, Promise.resolve(false)])) === true) {
            if (!graded.length) return null
            break
        }
        const entry = { index: i, grade: null, error: null }
        try {
            const state = await sandbox.apply(candidates[i])
            const score = await graders.score(state, candidates[i])
            if (typeof score !== 'number' || Number.isNaN(score)) throw new Error('grader-non-numeric')
            entry.grade = Math.max(0, Math.min(1, score))
        } catch (err) {
            entry.error = String((err && err.message) || err)
            log('ai-client', 'sandbox candidate failed', 'index=' + i, entry.error)
        }
        graded.push(entry)
    }

    const runnable = graded.filter((g) => g.grade !== null)
    const base = sigs[0]
    const agreeCount = (sig) => sigs.filter((s) => s === sig).length
    // Plan agreement stays in the record: it is the tiebreaker and the
    // continuity signal for the tap jsonl telemetry of #58.
    const planAgreement = sigs.every((s) => s === base)

    if (!runnable.length) {
        log('ai-client', 'no candidate gradable, greedy fallback (fail-soft)')
        return {
            plan_agreement: planAgreement,
            exec_grade: null,
            chosen: 0,
            candidates: graded,
            sandbox_failures: graded.length,
        }
    }

    let chosen = runnable[0]
    for (const g of runnable) {
        if (g.grade > chosen.grade) chosen = g
        else if (g.grade === chosen.grade && agreeCount(sigs[g.index]) > agreeCount(sigs[chosen.index])) chosen = g
        // full tie: the earlier (greedy-first) candidate wins by order
    }
    return {
        plan_agreement: planAgreement,
        exec_grade: chosen.grade,
        chosen: chosen.index,
        candidates: graded,
        sandbox_failures: graded.length - runnable.length,
    }
}
