import { describe, it, expect } from 'vitest';
import { TextDocument, paragraph } from '../src/engine/model.js';
import { TOOLS, TOOL_NAMES, changesDocument, documentSnapshot, describeCallFor, runTool } from '../src/lib/assistant-tools.js';

const engineFor = (lines = ['First paragraph', 'Second paragraph']) => {
  const model = new TextDocument(lines.map(text => paragraph(text)));
  const links = [];
  return {
    model,
    links,
    viewOnly: false,
    readOnly: false,
    execute(action) { const result = action(); return result === undefined ? true : result; },
    finishComposition() {},
    setHyperlink(target, text) { links.push({ target, text }); return true; },
  };
};

const tool = (engine, name, args = {}) => runTool(engine, name, args);

describe('assistant tools', () => {
  it('offers the document surface and marks which calls change it', () => {
    expect(TOOLS.length).toBe(9);
    expect(TOOLS.every(entry => entry.type === 'function' && entry.function.parameters.type === 'object')).toBe(true);
    expect([...TOOL_NAMES]).toEqual(expect.arrayContaining(['get_document_info', 'read_document', 'find_text', 'insert_text', 'replace_selection', 'format_text', 'insert_table', 'insert_page_break', 'insert_link']));
    expect(changesDocument('read_document')).toBe(false);
    expect(changesDocument('find_text')).toBe(false);
    expect(changesDocument('insert_text')).toBe(true);
  });

  it('reads paragraphs with their index and finds text without case', () => {
    const engine = engineFor(['Alpha beta', 'Gamma beta', 'Other']);
    const read = tool(engine, 'read_document');
    expect(read.ok).toBe(true);
    expect(read.content).toContain('[0] Alpha beta');
    expect(read.content).toContain('[2] Other');
    const found = tool(engine, 'find_text', { query: 'BETA' });
    expect(found.content).toContain('[0] Alpha beta');
    expect(found.content).toContain('[1] Gamma beta');
    expect(found.content).not.toContain('[2]');
    expect(tool(engine, 'find_text', { query: 'BETA', match_case: true }).content).toBe('No paragraph contains "BETA".');
  });

  it('inserts text and replaces only a real selection', () => {
    const engine = engineFor(['Hello world']);
    expect(tool(engine, 'replace_selection', { text: 'x' })).toMatchObject({ ok: false });
    engine.model.select(0, 5);
    expect(tool(engine, 'replace_selection', { text: 'Goodbye' }).ok).toBe(true);
    expect(engine.model.text).toContain('Goodbye world');
    tool(engine, 'insert_text', { text: '\nLast line', where: 'end' });
    expect(engine.model.text).toContain('Last line');
  });

  it('formats the selection with the model names, not CSS colors', () => {
    const engine = engineFor(['Styled text']);
    engine.model.select(0, 6);
    expect(tool(engine, 'format_text', { bold: true, color: '#FF0000', highlight: 'yellow', italic: true }).ok).toBe(true);
    const style = engine.model.runFormatting;
    expect(style.bold).toBe(true);
    expect(style.italic).toBe(true);
    expect(style.color).toBe('FF0000');
    expect(style.highlight).toBe('yellow');
    expect(tool(engine, 'format_text', { bold: true, target: 'document' }).ok).toBe(true);
  });

  it('builds a real table from rows and reports its size', () => {
    const engine = engineFor(['Before']);
    const rows = [['Word', 'Meaning'], ['apple', '苹果'], ['bridge', '桥']];
    const result = tool(engine, 'insert_table', { rows });
    expect(result.ok).toBe(true);
    expect(engine.model.tables.length).toBe(1);
    expect(engine.model.text).toContain('apple');
    expect(describeCallFor(engine, 'insert_table', { rows }).label).toBe('Insert a 3 by 2 table');
  });

  it('accepts a flat array of cell texts as one row', () => {
    const engine = engineFor(['Before']);
    const result = tool(engine, 'insert_table', { rows: ['品牌名', '国家', '代表车型'] });
    expect(result.ok).toBe(true);
    expect(result.content).toBe('Inserted a 1 by 3 table.');
    expect(engine.model.tables.length).toBe(1);
    expect(describeCallFor(engine, 'insert_table', { rows: ['a', 'b'] }).label).toBe('Insert a 1 by 2 table');
    const mixed = tool(engineFor(['Before']), 'insert_table', { rows: [['品牌', '国家'], 'BYD'] });
    expect(mixed.ok).toBe(true);
    expect(mixed.content).toBe('Inserted a 2 by 2 table.');
  });

  it('refuses an empty table and tells the model to fill the cells', () => {
    const engine = engineFor(['Before']);
    const empty = tool(engine, 'insert_table', { rows: [[], [], [], []] });
    expect(empty.ok).toBe(false);
    expect(empty.content).toContain('every cell filled');
    expect(tool(engine, 'insert_table', { rows: [] }).ok).toBe(false);
    expect(engine.model.tables.length).toBe(0);
  });

  it('inserts a page break and a link', () => {
    const engine = engineFor(['Link here']);
    engine.model.select(0, 4);
    expect(tool(engine, 'insert_page_break').ok).toBe(true);
    expect(engine.model.text).toContain('\f');
    expect(tool(engine, 'insert_link', { url: 'https://example.com' }).ok).toBe(true);
    expect(engine.links).toEqual([{ target: 'https://example.com', text: undefined }]);
  });

  it('reports the document to the model and rejects unknown tools', () => {
    const engine = engineFor(['# Heading\nBody', 'Something else']);
    const snapshot = documentSnapshot({ model: engine.model }, { docName: 'notes.docx' });
    expect(snapshot).toContain('notes.docx');
    expect(snapshot).toContain('paragraphs');
    expect(snapshot).toContain('Nothing is selected');
    expect(tool(engine, 'no_such_tool').ok).toBe(false);
    expect(tool(null, 'read_document').ok).toBe(false);
  });
});
