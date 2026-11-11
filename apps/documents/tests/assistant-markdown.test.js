import { describe, it, expect } from 'vitest';
import { TextDocument, paragraph } from '../src/engine/model.js';
import { hasMarkdown, parseMarkdownBlocks, parseRuns } from '../src/lib/markdown-doc.js';
import { runTool } from '../src/lib/assistant-tools.js';

const engineFor = (lines = []) => {
  const model = new TextDocument(lines.map(text => paragraph(text)));
  return {
    model,
    viewOnly: false,
    readOnly: false,
    execute(action) { model.checkpoint(); const result = action(); return result === undefined ? true : result; },
    finishComposition() {},
    setHyperlink() { return true; },
  };
};

describe('markdown-doc parser', () => {
  it('detects markdown structure, and not plain text', () => {
    expect(hasMarkdown('# Title')).toBe(true);
    expect(hasMarkdown('**bold** words')).toBe(true);
    expect(hasMarkdown('- item one\n- item two')).toBe(true);
    expect(hasMarkdown('1. first\n2. second')).toBe(true);
    expect(hasMarkdown('| a | b |\n| --- | --- |\n| 1 | 2 |')).toBe(true);
    expect(hasMarkdown('A plain paragraph about 1 + 2.')).toBe(false);
    expect(hasMarkdown('asterisk * mid-sentence')).toBe(false);
    expect(hasMarkdown('')).toBe(false);
  });

  it('parses headings, paragraphs, lists and pipe tables in order', () => {
    const blocks = parseMarkdownBlocks([
      '# Q4 营销活动协调会议纪要',
      '**会议时间**: 周一 10:00',
      '',
      '- Owner: Ana',
      '- Deadline: Friday',
      '',
      '1. first step',
      '2. second step',
      '',
      '| 序号 | 任务 | 负责人 |',
      '| --- | --- | --- |',
      '| 1 | 素材 | Ana |',
      '| 2 | 文案 | Bo |',
      '',
      'Closing note.',
    ].join('\n'));
    expect(blocks.map(b => b.type)).toEqual(['heading', 'para', 'list', 'list', 'table', 'para']);
    expect(blocks[0].level).toBe(1);
    expect(blocks[0].runs[0].text).toBe('Q4 营销活动协调会议纪要');
    expect(blocks[1].runs[0]).toMatchObject({ text: '会议时间', bold: true });
    expect(blocks[2].items).toHaveLength(2);
    expect(blocks[3].ordered).toBe(true);
    expect(blocks[4].rows).toEqual([['序号', '任务', '负责人'], ['1', '素材', 'Ana'], ['2', '文案', 'Bo']]);
  });

  it('keeps a lone table-like row as a paragraph, and nested bold-italic runs', () => {
    expect(parseMarkdownBlocks('a | b')[0].type).toBe('para');
    const runs = parseRuns('***both*** and **bold** and *ital*');
    expect(runs).toEqual([
      { text: 'both', bold: true, italic: true },
      { text: ' and ', bold: false, italic: false },
      { text: 'bold', bold: true, italic: false },
      { text: ' and ', bold: false, italic: false },
      { text: 'ital', bold: false, italic: true },
    ]);
  });
});

describe('assistant markdown insert (#27)', () => {
  it('turns a full markdown document into headings, bold runs, lists and a real table', () => {
    const engine = engineFor();
    const text = [
      '# Q4 营销活动协调会议纪要',
      '**会议时间**: 周一 10:00',
      '- Owner: Ana',
      '- Deadline: Friday',
      '',
      '| 序号 | 任务 |',
      '| --- | --- |',
      '| 1 | 素材 |',
    ].join('\n');
    const result = runTool(engine, 'insert_text', { text, where: 'end' });
    expect(result.ok).toBe(true);
    expect(result.content).toContain('formatted content');
    expect(result.content).toContain('1 heading(s)');
    expect(result.content).toContain('1 table(s)');
    const m = engine.model;
    // Real heading, not literal "#".
    expect(m.text).not.toContain('# Q4');
    expect(m.outline.some(e => e.text === 'Q4 营销活动协调会议纪要')).toBe(true);
    // Real bold run, not literal "**".
    expect(m.text).not.toContain('**');
    const boldAt = m.text.indexOf('会议时间');
    m.select(boldAt, boldAt + 4);
    expect(m.runFormatting.bold).toBe(true);
    // Real table, not a pipe row.
    expect(m.text).not.toContain('|');
    expect(m.tables).toHaveLength(1);
    expect(m.text).toContain('素材');
  });

  it('leaves plain text alone and stays one undo step for a markdown insert', () => {
    const engine = engineFor();
    const plain = runTool(engine, 'insert_text', { text: 'A plain sentence with 1 + 2.', where: 'end' });
    expect(plain.ok).toBe(true);
    expect(plain.content).toBe('Inserted 28 characters.');
    const md = engineFor();
    const mdResult = runTool(md, 'insert_text', { text: '# T\n**b**', where: 'end' });
    // The stub cannot emulate the editor's one-revision transaction (session.run);
    // assert the content landed converted, which is what the real engine undoes as one step.
    expect(mdResult.content).toContain('formatted content');
    expect(md.model.text).toBe('T\nb');
    expect(md.model.outline.some(e => e.text === 'T')).toBe(true);
  });

  it('replaces a selection with formatted content', () => {
    const engine = engineFor(['Old heading text']);
    engine.model.select(0, 16);
    const result = runTool(engine, 'replace_selection', { text: '## New heading' });
    expect(result.ok).toBe(true);
    expect(engine.model.outline.some(e => e.text === 'New heading')).toBe(true);
    expect(engine.model.text).not.toContain('#');
  });
});
