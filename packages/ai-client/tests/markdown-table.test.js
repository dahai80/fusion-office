import { describe, expect, it } from 'vitest';
import { parseMarkdownTable, parseMarkdownTableParts } from '../src/markdown-table.js';

describe('parseMarkdownTable', () => {
    it('reads a plain markdown table', () => {
        const text = 'Here you go:\n\n| Brand | Country |\n| --- | --- |\n| Acme | US |\n| Globex | UK |\n';
        expect(parseMarkdownTable(text)).toEqual([['Brand', 'Country'], ['Acme', 'US'], ['Globex', 'UK']]);
    });

    it('reads a table without the leading and trailing pipes', () => {
        expect(parseMarkdownTable('Step | Why\n--- | ---\nOne | start')).toEqual([['Step', 'Why'], ['One', 'start']]);
    });

    it('reads tab-separated rows', () => {
        expect(parseMarkdownTable('A\tB\n1\t2')).toEqual([['A', 'B'], ['1', '2']]);
    });

    it('reads a table wrapped in a code fence', () => {
        const text = '```\n| X | Y |\n| - | - |\n| a | b |\n| c | d |\n```';
        expect(parseMarkdownTable(text)).toEqual([['X', 'Y'], ['a', 'b'], ['c', 'd']]);
    });

    it('strips bold and code marks from cells', () => {
        expect(parseMarkdownTable('| **Name** | `ID` |\n| - | - |\n| **Ada** | `007` |')).toEqual([['Name', 'ID'], ['Ada', '007']]);
    });

    it('keeps empty middle cells and drops only the edge pipes', () => {
        expect(parseMarkdownTable('| A | B |\n| - | - |\n|  | x |')).toEqual([['A', 'B'], ['', 'x']]);
    });

    it('returns null for prose with a single delimiter line', () => {
        expect(parseMarkdownTable('Use a | pipe to separate values.')).toBeNull();
    });

    it('returns null for a table of one row', () => {
        expect(parseMarkdownTable('| A | B |')).toBeNull();
    });

    it('returns null when there is no table', () => {
        expect(parseMarkdownTable('Just a sentence, no table here.')).toBeNull();
    });

    it('keeps the first of several tables', () => {
        const text = '| A | B |\n| - | - |\n| 1 | 2 |\n\nOther:\n\n| C | D |\n| - | - |\n| 3 | 4 |';
        expect(parseMarkdownTable(text)).toEqual([['A', 'B'], ['1', '2']]);
    });

    it('says whether the table drew a header row', () => {
        expect(parseMarkdownTableParts('| Task | Notes |\n| --- | --- |\n| One | first |')).toEqual({ rows: [['Task', 'Notes'], ['One', 'first']], hasHeader: true });
        expect(parseMarkdownTableParts('| Task | Notes |\n| One | first |\n| Two | second |')).toEqual({ rows: [['Task', 'Notes'], ['One', 'first'], ['Two', 'second']], hasHeader: false });
    });
});
