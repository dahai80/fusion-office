/* Issue #55: presentation-layer filter for the assistant step list. The full
 * transcript stays in the agent's step log and the console; only the pane
 * rendering hides zero-effect edits and groups back-to-back identical reads.
 */

export function isNoopEdit(step) {
    if (step?.name !== 'insert_text') return false;
    return !String(step?.args?.text ?? '');
}

export function readGroupKey(step) {
    if (step?.name === 'get_document_info') return 'get_document_info';
    if (step?.name === 'read_document') return `read_document:${step?.args?.scope || 'document'}`;
    return null;
}
