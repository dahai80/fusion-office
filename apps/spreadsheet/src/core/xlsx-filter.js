/**
 * Autofilter conditions, the filterColumn elements of a sheet's or a
 * table's autoFilter, as this app's filter criteria and back. Excel matches
 * a value list against the text shown in the cell, as this app does, and a
 * custom filter's text with * and ? as wildcards, ~ escaping either.
 */

const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unescapeXml = (text) => String(text).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, entity) => {
  if (entity[0] !== '#') return XML_ENTITIES[entity.toLowerCase()] ?? m;
  const hex = /^#x/i.test(entity);
  const code = parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
  return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
});
const attr = (tag, name) => {
  const m = tag?.match(new RegExp(`\\s${name}="([^"]*)"`));
  return m ? unescapeXml(m[1]) : null;
};
const escapeAttr = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  .replace(/[\t\n\r]/g, (ch) => `&#${ch.charCodeAt(0)};`);

const COLUMN = /<(?:\w+:)?filterColumn\b([^<>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?filterColumn>)/g;
const CHILD = /<(?:\w+:)?(\w+)\b([^<>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?\1>)/;
const ITEM = /<(?:\w+:)?(\w+)\b([^<>]*?)\/?>/g;
const OPERATORS = { equal: 'eq', notEqual: 'neq', greaterThan: 'gt', greaterThanOrEqual: 'gte', lessThan: 'lt', lessThanOrEqual: 'lte' };
const numeric = (text) => /^\s*[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?\s*$/.test(text) && Number.isFinite(Number(text));

/**
 * A custom filter's text pattern as a condition: *x* contains, x* begins with,
 * *x ends with, otherwise an exact comparison. Null for a pattern this app's
 * conditions cannot express (a wildcard inside the text, "not begins with").
 */
function pattern(val, negate) {
  let leading = false;
  let trailing = false;
  let text = '';
  for (let i = 0; i < val.length; i++) {
    const ch = val[i];
    if (ch === '~' && i + 1 < val.length) { text += val[++i]; continue; }
    if (ch === '*') {
      if (!text && !leading) { leading = true; continue; }
      if (i === val.length - 1) { trailing = true; continue; }
      return null;
    }
    if (ch === '?') return null;
    text += ch;
  }
  if (!text) return null;
  if (leading && trailing) return { op: negate ? 'notContains' : 'contains', value: text };
  if (negate) return leading || trailing ? null : { op: 'neq', value: text };
  if (leading) return { op: 'endsWith', value: text };
  if (trailing) return { op: 'beginsWith', value: text };
  return { op: 'eq', value: text };
}

function customFilters(body, and) {
  const items = [...body.matchAll(ITEM)].filter((m) => m[1] === 'customFilter').map((m) => ({ op: attr(m[0], 'operator') || 'equal', val: attr(m[0], 'val') ?? '' }));
  if (!items.length || items.length > 2) return null;
  if (items.length === 2) {
    // "Between" is written as two bounds joined by and.
    const bounds = { greaterThanOrEqual: 'value', lessThanOrEqual: 'value2' };
    if (!and || !items.every((item) => bounds[item.op] && numeric(item.val)) || items[0].op === items[1].op) return null;
    const between = { op: 'between' };
    for (const item of items) between[bounds[item.op]] = Number(item.val);
    return between;
  }
  const [{ op, val }] = items;
  if (!Object.hasOwn(OPERATORS, op)) return null;
  const kind = OPERATORS[op];
  // Excel writes "not equal to a space" for its non-blanks filter.
  if (kind === 'neq' && val === ' ') return { op: 'notEmpty' };
  if (kind === 'eq' || kind === 'neq') {
    // Only a number's own spelling is that number: "007" and "1.50" are text codes, which Excel
    // matches as the text they are and this app would otherwise look for as 7 and 1.5.
    if (numeric(val) && String(Number(val)) === val.trim()) return { op: kind, value: Number(val) };
    return pattern(val, kind === 'neq');
  }
  return numeric(val) ? { op: kind, value: Number(val) } : null;
}

/**
 * The criteria of an autoFilter element, keyed by sheet column, or null when a
 * column's condition (a colour, an icon set, a top ten, a date group, a pattern
 * this app has no condition for) cannot be carried: a partial reading would
 * hide a different set of rows than the file shows.
 */
export function readXlsxFilter(xml, range) {
  const criteria = {};
  for (const [, open, body = ''] of String(xml).matchAll(COLUMN)) {
    const colId = Number(attr(`<c ${open}>`, 'colId'));
    if (!Number.isInteger(colId) || colId < 0 || range.c1 + colId > range.c2) return null;
    const child = body.match(CHILD);
    if (!child) continue;
    const [, name, attrs, inner = ''] = child;
    let criterion = null;
    if (name === 'filters') {
      const items = [...inner.matchAll(ITEM)];
      if (items.some((m) => m[1] !== 'filter')) return null;
      const values = items.map((m) => attr(m[0], 'val') ?? '');
      if (['1', 'true'].includes(attr(`<f ${attrs}>`, 'blank') ?? '')) values.push('');
      criterion = { values, caseSensitive: false };
    } else if (name === 'customFilters') criterion = customFilters(inner, ['1', 'true'].includes(attr(`<f ${attrs}>`, 'and') ?? ''));
    if (!criterion) return null;
    criteria[range.c1 + colId] = criterion;
  }
  return criteria;
}

/** Button visibility is independent of whether a column has a filter condition. */
export function readXlsxFilterButtons(xml, range) {
  const hidden = new Set();
  for (const [, open] of String(xml || '').replace(/<!--[\s\S]*?-->/g, '').matchAll(COLUMN)) {
    const tag = `<c ${open}>`, id = attr(tag, 'colId');
    if (id == null || !/^\d+$/.test(id)) continue;
    const c = range.c1 + Number(id);
    if (c > range.c2) continue;
    if (['1', 'true'].includes(attr(tag, 'hiddenButton')) || ['0', 'false'].includes(attr(tag, 'showButton'))) hidden.add(c);
  }
  if (hidden.size === range.c2 - range.c1 + 1) return { showButtons: false };
  return hidden.size ? { hiddenButtons: [...hidden].sort((a, b) => a - b) } : {};
}

/** A value as a custom filter's text: its wildcards made literal. */
const literal = (value) => String(value).replace(/[~*?]/g, (ch) => `~${ch}`);

/**
 * The filterColumn elements for a filter's criteria and button visibility, for the inside of its
 * autoFilter element. A criterion Excel has no condition for (a formula, a
 * colour) is left out; it travels in the sidecar, and the rows it hides are
 * hidden rows in the file either way.
 *
 * Excel judges a value list by the cell's value, not by the text it shows, so
 * `numbersByText(col)` may answer a Map from a listed text to the numbers the
 * column shows as that text; those numbers are written instead of the text,
 * and a text several numbers show as gets one element each.
 */
export function writeXlsxFilter(filter, numbersByText = null) {
  const range = filter?.range;
  if (!range) return '';
  const out = [];
  const custom = (items, and) => `<customFilters${and ? ' and="1"' : ''}>${items.map(([operator, val]) => `<customFilter operator="${operator}" val="${escapeAttr(val)}"/>`).join('')}</customFilters>`;
  const number = (value) => (typeof value === 'number' || (typeof value === 'string' && value.trim()) ? Number(value) : NaN);
  // Button visibility belongs to each native filterColumn, even when that
  // column has no condition. Omitting it makes Excel show buttons that were
  // hidden in an imported table or worksheet filter.
  const columns = new Set(Object.keys(filter.criteria || {}));
  const hidden = new Set(filter.hiddenButtons || []);
  for (const c of hidden) if (Number.isInteger(c)) columns.add(String(c));
  if (filter.showButtons === false) {
    for (let c = range.c1; c <= range.c2; c++) columns.add(String(c));
  }
  for (const key of columns) {
    const crit = filter.criteria?.[key] || {};
    const colId = Number(key) - range.c1;
    if (!Number.isInteger(colId) || colId < 0 || colId > range.c2 - range.c1 || !crit) continue;
    let body = null;
    if (Array.isArray(crit.values)) {
      const shown = crit.values.filter((value) => value !== '');
      const numbers = shown.length ? numbersByText?.(Number(key)) : null;
      const vals = shown.flatMap((value) => {
        const behind = numbers?.get(value);
        return behind?.length ? behind.map(String) : [String(value)];
      });
      body = `<filters${shown.length < crit.values.length ? ' blank="1"' : ''}>${vals.map((value) => `<filter val="${escapeAttr(value)}"/>`).join('')}</filters>`;
    } else if (crit.op === 'empty') body = '<filters blank="1"/>';
    else if (crit.op === 'notEmpty') body = custom([['notEqual', ' ']]);
    else if (crit.op === 'eq' || crit.op === 'neq') {
      // Equality takes either spelling here, so a criterion typed as text goes into the file as
      // that text: read as a number, "equals 007" became "equals 7" and Excel hid every 007 row.
      // A comparison below is numeric on both sides and keeps its coercion.
      const value = typeof crit.value === 'number' ? String(crit.value) : literal(crit.value ?? '');
      body = custom([[crit.op === 'eq' ? 'equal' : 'notEqual', value]]);
    } else if (['gt', 'gte', 'lt', 'lte'].includes(crit.op)) {
      if (Number.isFinite(number(crit.value))) body = custom([[{ gt: 'greaterThan', gte: 'greaterThanOrEqual', lt: 'lessThan', lte: 'lessThanOrEqual' }[crit.op], String(number(crit.value))]]);
    } else if (crit.op === 'between') {
      const a = number(crit.value), b = number(crit.value2);
      if (Number.isFinite(a) && Number.isFinite(b)) body = custom([['greaterThanOrEqual', String(Math.min(a, b))], ['lessThanOrEqual', String(Math.max(a, b))]], true);
    } else if (['contains', 'notContains', 'beginsWith', 'endsWith'].includes(crit.op) || (crit.text != null && !crit.formula && crit.color == null)) {
      const text = literal(crit.op ? crit.value ?? '' : crit.text);
      if (text) {
        const val = crit.op === 'beginsWith' ? `${text}*` : crit.op === 'endsWith' ? `*${text}` : `*${text}*`;
        body = custom([[crit.op === 'notContains' ? 'notEqual' : 'equal', val]]);
      }
    }
    const visibility = filter.showButtons === false || hidden.has(Number(key)) ? ' hiddenButton="1"' : '';
    if (body) out.push(`<filterColumn colId="${colId}"${visibility}>${body}</filterColumn>`);
    else if (visibility) out.push(`<filterColumn colId="${colId}"${visibility}/>`);
  }
  return out.join('');
}
