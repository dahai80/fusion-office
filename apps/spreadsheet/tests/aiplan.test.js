import { describe, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { createPlanner, validatePlan, PLAN_OPS } from '../src/core/aiplan.js';
import { runTool, describeCall } from '../src/core/aitools.js';

function setup({ fixture = [], approval = 'destructive', approveImpl } = {}) {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  const env = { sheetId: () => id, selection: () => ({ sheetId: id, range: { r1: 0, c1: 0, r2: 0, c2: 0 } }), distrust: vi.fn() };
  for (const [name, args] of fixture) runTool(wb, name, args, env);
  const requests = [];
  const approve = vi.fn(approveImpl ?? (async () => true));
  // One scripted model: rounds of stream parts, as chatStreamEvents yields them.
  return {
    wb, id, env, requests, approve,
    planner(replies) {
      let round = -1;
      return createPlanner({
        wb,
        chat: (messages) => {
          round++;
          requests.push(messages.map((m) => ({ ...m })));
          const parts = replies[round] || [{ type: 'text', text: 'done' }];
          return (async function* stream() { for (const p of parts) yield p; })();
        },
        runTool: (name, args) => runTool(wb, name, args, env),
        describe: (name, args) => describeCall(wb, name, args, env),
        approve,
        snapshot: () => 'The user is looking at "Sheet1".',
        settings: () => ({ approval }),
        env,
      });
    },
  };
}

const tool = (name, input) => ({ type: 'tool', name, input });
const text = (t) => ({ type: 'text', text: t });

describe('createPlanner', () => {
  it('applies a whole plan in order and reports it in one pass', async () => {
    const s = setup();
    const p = s.planner([
      [tool('apply_plan', { edits: [
        { tool: 'write_cells', args: { start_cell: 'A1', values: [['Month', 'Sales'], ['Jan', 100], ['Feb', 200]] } },
        { tool: 'write_cells', args: { start_cell: 'C1', values: [['Total'], ['=SUM(B2:B3)']] } },
        { tool: 'format_cells', args: { range: 'A1:C1', bold: true } },
      ] })],
      [text('Built the table; total in C2.')],
    ]);
    const out = await p.send('Make a small sales table with a total', () => {});
    expect(out.error).toBeUndefined();
    expect(out.applied).toBe(3);
    expect(out.planRounds).toBe(1);
    expect(s.wb.getValue(s.id, 0, 0)).toBe('Month');
    expect(s.wb.getValue(s.id, 1, 2)).toBe(300);
    expect(s.wb.getCell(s.id, 0, 0).s?.bold).toBe(true);
    // The model saw the computed value of its formula before writing the summary.
    const after = s.requests.at(-1).at(-1).content;
    expect(after).toContain('All 3 edits were applied');
    expect(after).toContain('300');
  });

  it('reads first, plans second, when the model looks before it commits', async () => {
    const s = setup();
    const p = s.planner([
      [tool('read_range', { range: 'A1:B2' })],
      [tool('apply_plan', { edits: [{ tool: 'write_cells', args: { start_cell: 'D1', values: [['ok']] } }] })],
      [text('wrote it')],
    ]);
    const out = await p.send('Add a marker', () => {});
    expect(out.applied).toBe(1);
    expect(out.steps.some((st) => st.name === 'read_range' && st.status === 'done')).toBe(true);
  });

  it('refuses a plan that names a change tool it cannot use, and lets the model revise', async () => {
    const s = setup();
    const p = s.planner([
      [tool('apply_plan', { edits: [{ tool: 'read_range', args: { range: 'A1' } }] })],
      [tool('apply_plan', { edits: [{ tool: 'write_cells', args: { start_cell: 'A1', values: [['x']] } }] })],
      [text('fixed')],
    ]);
    const out = await p.send('write x', () => {});
    expect(out.error).toBeUndefined();
    // The first plan was refused whole; nothing was applied by it.
    expect(s.wb.getValue(s.id, 0, 0)).toBe('x');
    const feedback = s.requests.at(-1).filter((m) => m.role === 'tool').map((m) => m.content).join('\n');
    expect(feedback).toContain('the plan was not applied');
    expect(feedback).toContain('which is not a change the plan can make');
  });

  it('refuses a plan whose address does not resolve, before anything is written', async () => {
    const s = setup();
    const p = s.planner([
      [tool('apply_plan', { edits: [{ tool: 'write_cells', args: { start_cell: 'Nope!A1', values: [['x']] } }] })],
      [text('cannot')],
    ]);
    const out = await p.send('write', () => {});
    expect(out.applied).toBe(0);
    const feedback = s.requests.at(-1).filter((m) => m.role === 'tool').map((m) => m.content).join('\n');
    expect(feedback).toContain('not a usable address');
  });

  it('stops at the first failing edit and says what applied', async () => {
    const s = setup();
    const p = s.planner([
      [tool('apply_plan', { edits: [
        { tool: 'write_cells', args: { start_cell: 'A1', values: [['good']] } },
        { tool: 'write_cells', args: { start_cell: 'B1', values: 'not an array of rows' } },
        { tool: 'write_cells', args: { start_cell: 'B1', values: [['never']] } },
      ] })],
    ]);
    const out = await p.send('do it', () => {});
    expect(out.applied).toBe(1);
    expect(s.wb.getValue(s.id, 0, 0)).toBe('good');
    expect(s.wb.getValue(s.id, 0, 1)).toBeNull();
    const feedback = s.requests.at(-1).filter((m) => m.role === 'tool').map((m) => m.content).join('\n');
    expect(feedback).toContain('stopped at edit 2 of 3');
    expect(feedback).toContain('were applied and stay');
  });

  it('asks once about a destructive plan and applies nothing when declined', async () => {
    const s = setup({ fixture: [['write_cells', { start_cell: 'A1', values: [['keep me']] }]] });
    const p = s.planner([
      [tool('apply_plan', { edits: [{ tool: 'clear_range', args: { range: 'A1', what: 'all' } }] })],
      [text('understood, left it alone')],
    ], { approveImpl: undefined });
    s.approve.mockResolvedValue(false);
    const out = await p.send('clear it', () => {});
    expect(out.applied).toBe(0);
    expect(s.approve).toHaveBeenCalledTimes(1);
    expect(s.approve.mock.calls[0][0].destructive).toBe(true);
    expect(s.wb.getValue(s.id, 0, 0)).toBe('keep me');
  });

  it('applies a non-destructive plan without asking', async () => {
    const s = setup();
    const p = s.planner([
      [tool('apply_plan', { edits: [{ tool: 'write_cells', args: { start_cell: 'A1', values: [['new']] } }] })],
      [text('done')],
    ]);
    await p.send('write', () => {});
    expect(s.approve).not.toHaveBeenCalled();
  });

  it('rejects an empty plan and a plan with too many edits', () => {
    const s = setup();
    expect(validatePlan(s.wb, s.env, { edits: [] })).toContain('no edits');
    expect(validatePlan(s.wb, s.env, {})).toContain('no edits');
    const many = Array.from({ length: 41 }, () => ({ tool: 'write_cells', args: { start_cell: 'A1', values: [['x']] } }));
    expect(validatePlan(s.wb, s.env, { edits: many })).toContain('most one plan may apply');
    expect(PLAN_OPS).not.toContain('select_range');
    expect(PLAN_OPS).not.toContain('read_range');
  });
});
