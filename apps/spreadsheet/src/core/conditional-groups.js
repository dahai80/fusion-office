import { conditionalPredicateField, rebaseConditionalPredicate } from './conditional-scale.js';
/** Adjacent, equivalent paint pieces form one editable conditional rule. */
import { shiftFormula, sameSheetName } from './refs.js';
import { duplicateSourceAreas, duplicateSourceFormula } from './conditional-duplicates.js';
import { removeRangeRecords, forEachRangeRecordIn } from './range-records.js';

const statistical = new Set(['scale', 'databar', 'icons', 'dup', 'unique', 'top', 'bottom']);
const equal = (a, b) => {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  const keys = Object.keys(a).filter(key => a[key] !== undefined), other = Object.keys(b).filter(key => b[key] !== undefined);
  return keys.length === other.length && keys.every(key => equal(a[key], b[key]));
};
const body = value => String(value ?? '').trim().replace(/^=/, '').trim();
const settings = ({ id, range, ...rule }) => ({ ...rule, style: rule.style || {}, stopIfTrue: rule.stopIfTrue !== false,
  ...(rule.type === 'formula' ? { value: body(rule.value) } : {}) });

export function conditionalRuleGroups(rules) {
  const groups = [];
  for (const rule of rules) {
    const last = groups.at(-1), first = last?.rule;
    let compatible = first && rule.type !== 'bands';
    if (compatible && statistical.has(rule.type)) compatible = !!(rule.statisticsRange || rule.duplicateRange);
    if (compatible) {
      const expected = settings(first), actual = settings(rule);
      const predicate = conditionalPredicateField(first);
      if (predicate) expected[predicate] = body(shiftFormula(first[predicate], rule.range.r1 - first.range.r1, rule.range.c1 - first.range.c1));
      compatible = equal(expected, actual);
    }
    if (compatible) last.rules.push(rule);
    else groups.push({ rule, rules: [rule] });
  }
  return groups;
}

export function conditionalRangesCoverSource(source, ranges, sheetName) {
  const areas = duplicateSourceAreas(source);
  if (!areas?.length || areas.some(g => g.sheet && !sameSheetName(g.sheet, sheetName))) return false;
  const key = g => `${g.r1},${g.c1},${g.r2},${g.c2}`;
  const sourceKeys = new Set(areas.map(key)), rangeKeys = new Set(ranges.map(key));
  if (sourceKeys.size === rangeKeys.size && [...sourceKeys].every(k => rangeKeys.has(k))) return true;
  const covers = (a, b) => {
    const records = b.map(range => ({ range }));
    return a.every(range => {
      let left = [{ range }];
      forEachRangeRecordIn(records, range, cut => { if (left.length) left = removeRangeRecords(left, cut.range); });
      return left.length === 0;
    });
  };
  return covers(areas, ranges) && covers(ranges, areas);
}

/** Keep the first area's formula anchor, removing duplicate paint coverage. */
export function distinctConditionalRanges(ranges) {
  const out = [];
  for (const range of ranges) {
    const left = out.reduce((items, cut) => removeRangeRecords(items, cut), [{ range }]);
    out.push(...left.map(item => item.range));
  }
  return out;
}

/** Preserve explicit foreign statistical sources; automatic domains follow edits. */
export function conditionalGroupPieces(base, originals, ranges, sheetName, newId) {
  const source = duplicateSourceFormula(ranges), oldRanges = originals.map(rule => rule.range);
  const next = { ...base };
  if (statistical.has(base.type)) {
    if (!base.statisticsRange && !base.duplicateRange && ranges.length > 1 || base.statisticsRange && conditionalRangesCoverSource(base.statisticsRange, oldRanges, sheetName)) next.statisticsRange = source;
    if (base.duplicateRange && conditionalRangesCoverSource(base.duplicateRange, oldRanges, sheetName)) next.duplicateRange = source;
  }
  return ranges.map((range, i) => ({ ...rebaseConditionalPredicate(next, range.r1 - ranges[0].r1, range.c1 - ranges[0].c1),
    range, id: originals[i]?.id || newId() }));
}

/** Commas inside quoted sheet names and structured column references are not separators. */
export function splitConditionalRanges(text) {
  let value = String(text || '').trim();
  if (value.startsWith('(') && value.endsWith(')')) value = value.slice(1, -1);
  const parts = []; let start = 0, quote = false, brackets = 0;
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (c === "'" && brackets) { i++; continue; }
    if (c === "'" && !brackets) { if (quote && value[i + 1] === "'") i++; else quote = !quote; }
    else if (!quote) {
      if (c === '[') brackets++;
      if (c === ']') { if (--brackets < 0) return null; }
      if (c === ',' && !brackets) { parts.push(value.slice(start, i).trim()); start = i + 1; }
    }
  }
  parts.push(value.slice(start).trim());
  return quote || brackets || parts.some(part => !part) ? null : parts;
}
