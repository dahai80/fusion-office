import { describe, it, expect } from 'vitest';
import { isNoopEdit, readGroupKey } from '../src/lib/assistant-steps.js';

describe('assistant step list filter (issue #55)', () => {
    it('flags empty insert_text calls as no-op edits', () => {
        expect(isNoopEdit({ name: 'insert_text', args: { text: '' } })).toBe(true);
        expect(isNoopEdit({ name: 'insert_text', args: {} })).toBe(true);
        expect(isNoopEdit({ name: 'insert_text', args: { text: 'hi' } })).toBe(false);
    });

    it('leaves every other step untouched', () => {
        expect(isNoopEdit({ name: 'read_document', args: {} })).toBe(false);
        expect(isNoopEdit({ name: 'replace_selection', args: { text: '' } })).toBe(false);
        expect(isNoopEdit(null)).toBe(false);
        expect(isNoopEdit({ name: 'insert_text' })).toBe(true);
    });

    it('groups reads by tool and scope only', () => {
        expect(readGroupKey({ name: 'get_document_info', args: {} })).toBe('get_document_info');
        expect(readGroupKey({ name: 'read_document', args: {} })).toBe('read_document:document');
        expect(readGroupKey({ name: 'read_document', args: { scope: 'selection' } })).toBe('read_document:selection');
        expect(readGroupKey({ name: 'find_text', args: { query: 'x' } })).toBeNull();
        expect(readGroupKey({ name: 'insert_text', args: { text: 'x' } })).toBeNull();
        expect(readGroupKey(undefined)).toBeNull();
    });
});
