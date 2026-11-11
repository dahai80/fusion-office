// Markdown to document blocks, for the assistant's insert path: a model that
// answers with Markdown instead of tool calls (issue #27) must not land as
// literal "# Title" and "**bold**" text. parseMarkdownBlocks turns the text
// into blocks the tool layer writes through the document model — real heading
// styles, run formatting, lists and tables.

const HEADING_RE = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/m;
const BULLET_RE = /^\s{0,3}[-*+]\s+(.+)$/m;
const ORDERED_RE = /^\s{0,3}\d{1,9}[.)]\s+(.+)$/m;
const TABLE_ROW_RE = /^\s{0,3}\|(.+)\|\s*$/;
const TABLE_SEP_RE = /^\s{0,3}\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

/** Does the text carry Markdown structure the insert path should convert? */
export function hasMarkdown(text) {
  const s = String(text ?? '');
  if (HEADING_RE.test(s)) return true;
  if (BULLET_RE.test(s) || ORDERED_RE.test(s)) return true;
  if (/\*\*[^*\n]+\*\*/.test(s) || /(^|[^*\w])\*[^*\n]+\*(?![*\w])/.test(s)) return true;
  const lines = s.split('\n');
  return lines.some((line, i) => TABLE_ROW_RE.test(line) && i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1]));
}

/** Inline runs: **bold**, *italic*, ***both***, `code` (as plain text). */
export function parseRuns(text) {
  const runs = [];
  let bold = 0, italic = 0, buf = '';
  const flush = () => { if (buf) { runs.push({ text: buf, bold: bold > 0, italic: italic > 0 }); buf = ''; } };
  let i = 0;
  const s = String(text ?? '');
  while (i < s.length) {
    if (s.startsWith('***', i)) { flush(); bold = 1 - bold; italic = 1 - italic; i += 3; continue; }
    if (s.startsWith('**', i)) { flush(); bold = 1 - bold; i += 2; continue; }
    if (s[i] === '*' && !/\s/.test(s[i + 1] ?? '')) { flush(); italic = 1 - italic; i += 1; continue; }
    if (s[i] === '`') {
      const end = s.indexOf('`', i + 1);
      if (end > i) { flush(); buf += s.slice(i + 1, end); flush(); i = end + 1; continue; }
    }
    buf += s[i];
    i += 1;
  }
  flush();
  return runs.length ? runs : [{ text: '', bold: false, italic: false }];
}

const runsOf = (text) => parseRuns(text);
const cell = (raw) => parseRuns(raw.trim()).map(r => r.text).join('').trim();

/** Pipe-table rows from a line "| a | b |"; null when the line is not one. */
function tableRow(line) {
  const match = TABLE_ROW_RE.exec(line);
  if (!match) return null;
  return match[1].split('|').map(cell);
}

/**
 * The text as an ordered list of blocks:
 *   { type: 'heading', level, runs }        # up to ######
 *   { type: 'para', runs }
 *   { type: 'list', ordered, items: [runs] }
 *   { type: 'table', rows: [[cellText]] }
 * Unrecognized lines keep their literal text; a lone table row without a
 * separator under it is a paragraph, not a table.
 */
export function parseMarkdownBlocks(text) {
  const lines = String(text ?? '').split('\n');
  const blocks = [];
  let para = [];
  const flushPara = () => {
    if (para.length) { blocks.push({ type: 'para', runs: runsOf(para.join(' ')) }); para = []; }
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const heading = HEADING_RE.exec(line);
    if (heading) { flushPara(); blocks.push({ type: 'heading', level: heading[1].length, runs: runsOf(heading[2]) }); continue; }
    const bullet = BULLET_RE.exec(line);
    const ordered = bullet ? null : ORDERED_RE.exec(line);
    if (bullet || ordered) {
      flushPara();
      const itemRe = bullet ? BULLET_RE : ORDERED_RE;
      const kind = { ordered: !!ordered, items: [runsOf((bullet || ordered)[1])] };
      while (i + 1 < lines.length) {
        const next = itemRe.exec(lines[i + 1]);
        if (next) { kind.items.push(runsOf(next[1])); i += 1; continue; }
        // A blank line between two items of the same kind does not end the list.
        if (!lines[i + 1].trim() && i + 2 < lines.length && itemRe.test(lines[i + 2])) { i += 1; continue; }
        break;
      }
      blocks.push({ type: 'list', ...kind });
      continue;
    }
    const row = tableRow(line);
    if (row && i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1])) {
      flushPara();
      const rows = [row];
      i += 1; // the separator line
      while (i + 1 < lines.length && tableRow(lines[i + 1])) { rows.push(tableRow(lines[i + 1])); i += 1; }
      blocks.push({ type: 'table', rows });
      continue;
    }
    if (line.trim()) para.push(line.trim());
    else flushPara();
  }
  flushPara();
  return blocks;
}
