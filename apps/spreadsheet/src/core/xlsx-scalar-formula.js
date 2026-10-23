import { parseFormula } from './formula/parser.js';
import { astToText } from './formula/print.js';
import { FUNCTIONS } from './formula/functions.js';

const REFERENCE_RESULTS = new Set(['OFFSET', 'INDIRECT', 'INDEX']);
const SCALAR_CHOICES = new Set(['IF', 'IFERROR', 'IFNA', 'IFS', 'SWITCH']);

/** Make legacy single-value evaluation explicit where an expression consumes
 * scalars. Range/array consumers keep their arguments intact: SUMPRODUCT and
 * aggregate formulas must not lose the arrays they intentionally evaluate.
 * Call only for ordinary XLSX cells, never names or array-formula records.
 */
export function xlsxScalarFormula(formula) {
  let changed = false;
  const intersect = node => { changed = true; return { type: 'unary', op: '@', arg: node }; };
  const visit = (node, depth = 0) => {
    if (depth > 200) throw new RangeError('Formula nesting');
    const next = child => visit(child, depth + 1);
    switch (node.type) {
      case 'ref': return node.ref.kind !== 'cell' && !node.ref.spill ? intersect(node) : node;
      // Table import handles column/row semantics and array calculated columns.
      case 'tref': return node;
      case 'range': case 'intersection': case 'union': case 'array': return intersect(node);
      case 'unary': return node.op === '@' ? node : { ...node, arg: next(node.arg) };
      case 'percent': return { ...node, arg: next(node.arg) };
      case 'binary': return { ...node, left: next(node.left), right: next(node.right) };
      case 'call':
        // Names keep their own expression context; explicit spill references and
        // table expressions are handled outside this scalar-range conversion.
        if (node.bare) return node;
        if (!node.sheet && REFERENCE_RESULTS.has(node.name)) return intersect(node);
        if (!node.sheet && (SCALAR_CHOICES.has(node.name) || FUNCTIONS[node.name]?.lift)) {
          return { ...node, args: node.args.map(next) };
        }
        return node;
      default: return node;
    }
  };
  try {
    const result = visit(parseFormula(formula));
    return changed ? astToText(result) : formula;
  } catch { return formula; }
}
