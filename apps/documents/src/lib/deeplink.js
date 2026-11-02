/**
 * Deep-link import (issue #6): another Fusion module, such as fusion-design,
 * opens the app at `#/new` with content to start from, the same path a
 * dropped Markdown, HTML, or text file takes once it is decoded:
 *
 *   #/new?title=<name>&body=<urlencoded content>&format=html|markdown|text&source=<module>
 *
 * `format` defaults to markdown; `title` and `name` are synonyms for the
 * document name; `source` is recorded in the log only. The content rides in
 * the fragment, so it never reaches a server; a link this long is a
 * programmatic hand-off, not something to type or share by hand.
 */

import { toInsertPayload } from './importers.js';

/** Browsers keep multi-megabyte locations to themselves; past this the hand-off should go through a file instead. */
export const MAX_DEEPLINK_BODY_CHARS = 1000000;

const FORMATS = { html: 'html', markdown: 'markdown', md: 'markdown', text: 'text', txt: 'text', plain: 'text' };

/** { name, payload, source } for a #/new deep link with content, else null. Throws when the content is too large. */
export function parseDeepLinkImport(hash = location.hash) {
    const m = /^#\/new\?(.*)$/.exec(String(hash || ''));
    if (!m) return null;
    const params = new URLSearchParams(m[1]);
    const body = params.get('body');
    if (!body) return null;
    if (body.length > MAX_DEEPLINK_BODY_CHARS) {
        throw new Error(`That link carries too much content: up to ${MAX_DEEPLINK_BODY_CHARS} characters can be imported this way`);
    }
    const format = FORMATS[(params.get('format') || '').trim().toLowerCase()] || 'markdown';
    return {
        name: params.get('title') || params.get('name') || '',
        payload: toInsertPayload(body, format),
        source: (params.get('source') || '').slice(0, 200),
    };
}
