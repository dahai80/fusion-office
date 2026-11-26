// Outcome signals for the rollout-tap training data plane (issue #33). Every
// confirmed or failed agent action is reported as one rollout-tap schema v1
// record; office-api appends it to the sink file fusion-trainer's
// rollout_ingest reads. Signals and their default rewards match
// fusion-trainer's SIGNAL_SCORES exactly. Reporting is fire-and-forget: a
// failed emit is a log line, never an error the user sees.

export const OUTCOME_SIGNALS = Object.freeze({
    task_success: 1.0,
    user_accepted: 1.0,
    user_edited: 0.5,
    user_rejected: 0.0,
    error: 0.0,
});

export function outcomeScore(signal) {
    return Object.prototype.hasOwnProperty.call(OUTCOME_SIGNALS, signal) ? OUTCOME_SIGNALS[signal] : null;
}

/** "ro-<16 hex>" as the gateway mints them; a time fallback keeps ids unique enough. */
export function newRolloutId() {
    const hex = () => Math.floor(Math.random() * 0xffff).toString(16).padStart(4, '0');
    return `ro-${hex()}${hex()}${hex()}${hex()}`;
}

const REDACT_MAX_MESSAGES = 40;
const RAW_MAX_MESSAGES = 200;
const RAW_MAX_CONTENT = 8000;

function redactContent(content) {
    return `[redacted:${String(content ?? '').length}]`;
}

function rawContent(content) {
    const text = String(content ?? '');
    return text.length > RAW_MAX_CONTENT ? `${text.slice(0, RAW_MAX_CONTENT)}…` : text;
}

/**
 * One reporter per app. contentMode defaults to the gateway tap's "redact":
 * message content is dropped, the length survives. "raw" keeps verbatim
 * content (capped) for SFT/GRPO quality — opt in per build.
 */
export function createOutcomeReporter({ app, endpoint = 'http://127.0.0.1:11492/v1/outcomes', fetchImpl = globalThis.fetch?.bind(globalThis), contentMode = 'redact' } = {}) {
    const reported = new Set(); // event ids already emitted; many events may belong to one turn
    let warned = 0;

    function buildRecord({ signal, detail, model, messages = [], rolloutId, eventId }) {
        const maxMessages = contentMode === 'raw' ? RAW_MAX_MESSAGES : REDACT_MAX_MESSAGES;
        const shape = contentMode === 'raw' ? rawContent : redactContent;
        const record = {
            schema_version: 1,
            rollout_id: rolloutId || newRolloutId(),
            ...(eventId ? { event_id: eventId } : {}),
            // Trainer's dashboard treats records with `source` as trajectories.
            // Correlated events are sidecars; keep app provenance without double-counting.
            [eventId ? 'app_source' : 'source']: `fusion-office/${app || 'unknown'}`,
            created_at: new Date().toISOString(),
            messages: messages.slice(-maxMessages).map(m => ({ role: String(m.role || 'user'), content: shape(m.content) })),
            outcome: { signal, score: outcomeScore(signal), ...(detail ? { detail: String(detail).slice(0, 500) } : {}) },
        };
        if (model) record.model = model;
        return record;
    }

    /**
     * Emit one outcome. Idempotent per eventId (or rolloutId for single-event callers), never throws, never blocks:
     * the caller awaits nothing and a failed POST only logs.
     */
    function report({ signal, detail, model, messages = [], rolloutId, eventId } = {}) {
        if (!Object.prototype.hasOwnProperty.call(OUTCOME_SIGNALS, signal)) {
            console.warn(`[ai-client] dropped unknown outcome signal "${signal}"`);
            return;
        }
        const key = eventId || rolloutId;
        if (key && reported.has(key)) return;
        if (key) reported.add(key);
        if (reported.size > 500) {
            for (const id of reported) { reported.delete(id); if (reported.size <= 250) break; }
        }
        if (!fetchImpl) return;
        const record = buildRecord({ signal, detail, model, messages, rolloutId, eventId });
        try {
            Promise.resolve(fetchImpl(endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(record),
                keepalive: true,
            })).then((res) => {
                if (res?.ok === false) throw new Error(`HTTP ${res.status}`);
            }).catch((err) => {
                // One warning per streak, not per dropped record: an offline
                // session must not flood the console.
                warned += 1;
                if (warned === 1 || warned % 50 === 0) {
                    console.warn(`[ai-client] outcome report dropped (${warned} total): ${err?.message || err}`);
                }
            });
        } catch (err) {
            console.warn(`[ai-client] outcome report dropped: ${err?.message || err}`);
        }
    }

    // Bind late feedback to the reply, not whichever turn is active on click.
    function feedback(turn, reply, signal) {
        if (!turn?.rolloutId) return;
        report({ ...turn, signal, eventId: `${turn.rolloutId}:feedback:${signal}`,
            messages: [{ role: 'assistant', content: reply }] });
    }

    return { report, feedback, buildRecord, OUTCOME_SIGNALS };
}
