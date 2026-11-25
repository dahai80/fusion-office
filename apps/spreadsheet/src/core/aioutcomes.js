/**
 * Outcome signals for the rollout-tap plane (#33), re-exported from the shared
 * ai-client so the core modules (aiagent.js, aiplan.js) stay import-graph clean:
 * they take an `outcomes` reporter from their caller, and only the UI layer
 * builds one.
 */

export { createOutcomeReporter, newRolloutId, outcomeScore, OUTCOME_SIGNALS } from '@fusion-office/ai-client';
