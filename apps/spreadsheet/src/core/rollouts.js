// Cross-session memory for the spreadsheet agent (issues #45/#47, GrepMem):
// regex retrieval over the outcome log office-api keeps (GET /v1/rollouts/grep).
// The tool is dispatched outside the synchronous runTool registry because it is
// the only one that reaches the network, and runTool stringifies a runner's
// return synchronously — a fetch-backed runner would report as {}.

import { cutText } from './cell.js';

export const OFFICE_API_URL =
    (typeof import.meta !== 'undefined' && import.meta.env?.VITE_FUSION_OFFICE_API_URL) ||
    'http://127.0.0.1:11492';
const FETCH_TIMEOUT_MS = 10000;
const MAX_CONTENT_CHARS = 20000;

export const ASYNC_TOOLS = new Set(['grep_rollouts']);

export function isAsyncTool(name) {
    return ASYNC_TOOLS.has(name);
}

/** Run one network-backed tool. Returns the same shape as aitools.runTool. */
export async function runAsyncTool(name, args = {}) {
    if (name !== 'grep_rollouts') {
        return { ok: false, content: `There is no tool called ${name}.`, changed: false, target: null };
    }
    const query = String(args.query ?? '').trim();
    if (!query) {
        return {
            ok: false,
            content: 'Error: query is required; give the text or regular expression to look for.',
            changed: false,
            target: null,
        };
    }
    const limit = Math.min(100, Math.max(1, Math.trunc(Number(args.limit)) || 20));
    const url = `${OFFICE_API_URL}/v1/rollouts/grep?q=${encodeURIComponent(query)}&limit=${limit}`;
    try {
        const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
        if (!response.ok) {
            const detail = await response.json().catch(() => null);
            console.warn(`[rollouts] grep_rollouts refused: ${response.status} ${detail?.detail ?? ''}`.trim());
            return {
                ok: false,
                content: `Error: the outcome log refused the lookup (${response.status}${detail?.detail ? `: ${detail.detail}` : ''}).`,
                changed: false,
                target: null,
            };
        }
        const body = await response.json();
        const matches = Array.isArray(body.matches) ? body.matches : [];
        console.info(`[rollouts] grep_rollouts matched ${matches.length} line(s) for ${JSON.stringify(query)}`);
        return {
            ok: true,
            content: cutText(
                JSON.stringify({ matches, truncated: !!body.truncated, exists: body.exists !== false }),
                MAX_CONTENT_CHARS,
            ),
            changed: false,
            target: null,
        };
    } catch (error) {
        console.warn(`[rollouts] grep_rollouts could not reach office-api at ${OFFICE_API_URL}: ${error?.message || error}`);
        return {
            ok: false,
            content: `Error: office-api is not reachable at ${OFFICE_API_URL}, so past-session outcomes cannot be searched. Answer from the workbook alone and say the memory is unavailable.`,
            changed: false,
            target: null,
        };
    }
}
