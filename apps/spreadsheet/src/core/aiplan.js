/**
 * Plan-then-apply: an alternative to the step-by-step agent loop (aiagent.js) for building
 * tasks. The model reads the workbook with the read tools, then commits the whole change as
 * one apply_plan call: a list of edits that is validated as a whole before anything is
 * written, asked about once, and applied in order. A plan that fails validation goes back
 * to the model to revise; one that fails part-way stops there and says what applied.
 *
 * Everything the model can reach comes from the caller (chat, runTool, describe, approve,
 * snapshot, settings, env), as in aiagent.js, so the whole exchange plays out in a test with
 * a scripted model. UI wiring is not part of this module.
 */

import { cutText } from './cell.js';
import { TOOLS, TOOL_NAMES, changesWorkbook, describeCall, resolveRange } from './aitools.js';
import { SYSTEM_PROMPT, requestMessages, userContent } from './aiagent.js';

const READ_NAMES = ['get_workbook_info', 'read_range', 'calculate', 'find'];

/** The tools a plan may call: every change tool except select_range (view-only, not a change to plan). */
export const PLAN_OPS = [...TOOL_NAMES].filter((name) => changesWorkbook(name) && name !== 'select_range');

/** The read tools stay available while planning, so the model can look before it commits. */
export const PLAN_TOOLS = [
  ...TOOLS.filter((t) => READ_NAMES.includes(t.function.name)),
  {
    type: 'function',
    function: {
      name: 'apply_plan',
      description: 'Apply every change the task needs as one plan, after you have read what you need. Each edit is one tool call, in the order to apply it. The plan is checked as a whole before anything is written, and the user is asked once about all of it, so put the complete change here instead of calling change tools one at a time.',
      parameters: {
        type: 'object',
        properties: {
          edits: {
            type: 'array',
            description: 'The edits, in order.',
            items: {
              type: 'object',
              properties: {
                tool: { type: 'string', enum: PLAN_OPS, description: 'The change tool to call.' },
                args: { type: 'object', description: 'Its arguments, exactly as that tool takes them.' },
              },
              required: ['tool', 'args'],
              additionalProperties: false,
            },
          },
          notes: { type: 'string', description: 'One line on what the plan does, shown to the user with the question.' },
        },
        required: ['edits'],
        additionalProperties: false,
      },
    },
  },
];

export const PLAN_TOOL_NAMES = new Set(PLAN_TOOLS.map((t) => t.function.name));

export const MAX_PLAN_ROUNDS = 8;
export const MAX_PLAN_EDITS = 40;

const PLAN_ADDENDUM = `Planning mode
- You are in plan-then-apply mode: read what you need (get_workbook_info, read_range, calculate, find), then commit the whole change with one apply_plan call. Do not call change tools one at a time; everything that changes the workbook belongs in the plan.
- Each edit's args are exactly the arguments of that tool. Order the edits so that later ones can build on earlier ones.
- After a plan is applied you are shown each edit's result, including the computed values behind any formulas you wrote: check them and tell the user what changed, or correct what went wrong with a new plan.`;

/** The system prompt for planning: the workbook prompt plus the planning addendum. */
export const planSystemPrompt = () => `${SYSTEM_PROMPT}\n\n${PLAN_ADDENDUM}`;

/** What a single edit of a plan would do, for the question and the report: { label, destructive, detail }. */
function describeEdit(wb, env, edit) {
  try { return describeCall(wb, edit.tool, edit.args || {}, env) || { label: edit.tool }; } catch { return { label: edit.tool }; }
}

/** Validate a plan's shape and addresses before anything is applied. Returns null, or the error text. */
export function validatePlan(wb, env, input) {
  const edits = input?.edits;
  if (!Array.isArray(edits) || !edits.length) return 'The plan has no edits. Call apply_plan with the edits the task needs, or answer in text if no change is needed.';
  if (edits.length > MAX_PLAN_EDITS) return `The plan has ${edits.length} edits; the most one plan may apply is ${MAX_PLAN_EDITS}. Split the work.`;
  for (let i = 0; i < edits.length; i++) {
    const edit = edits[i];
    const name = String(edit?.tool || '');
    if (!PLAN_OPS.includes(name)) return `Edit ${i + 1} calls "${name || '(nothing)'}", which is not a change the plan can make. Use one of: ${PLAN_OPS.join(', ')}.`;
    if (!edit?.args || typeof edit.args !== 'object' || Array.isArray(edit.args)) return `Edit ${i + 1} (${name}) has no arguments object.`;
    // The address named must resolve now: a plan that writes to a range that does not exist is refused whole.
    const text = edit.args.range ?? edit.args.start_cell ?? edit.args.data_range ?? edit.args.cell;
    if (text != null) {
      try { resolveRange(wb, String(text), env.sheetId()); } catch (e) {
        return `Edit ${i + 1} (${name}) names "${text}", which is not a usable address on this workbook (${e?.message || 'not readable'}).`;
      }
    }
  }
  return null;
}

/**
 * An assistant that works plan-then-apply on one workbook. The arguments are createAgent's
 * (aiagent.js) plus `env`, the tool environment the panel already builds (sheetId, selection,
 * distrust). send(text, onEvent) resolves to { stopped, error, steps, applied, planRounds }:
 * `applied` counts the edits written, `steps` carries every step shown, plan rounds included.
 */
export function createPlanner({ wb, chat, runTool: run, describe, approve, snapshot = () => '', settings = () => ({}), env }) {
  let messages = [];
  let running = null;

  async function exchange(onEvent) {
    const transcript = messages;
    const emit = (e) => { try { onEvent?.(e); } catch (err) { console.error(err); } };
    let stopResolve;
    const stopSignal = new Promise((resolve) => { stopResolve = resolve; });
    const runState = { stopped: false, stop() { if (!this.stopped) { this.stopped = true; stopResolve(STOP); } } };
    running = runState;
    const steps = [];
    let applied = 0;
    let planRounds = 0;
    const control = {
      stopped: () => runState.stopped,
      waiting: () => {},
    };
    try {
      for (let round = 0; round < MAX_PLAN_ROUNDS; round++) {
        if (round) emit({ type: 'round' });
        let text = '';
        const calls = [];
        const iterable = chat(requestMessages(transcript, { system: planSystemPrompt() }), { tools: PLAN_TOOLS, maxTokens: 32000 });
        for (;;) {
          const next = await Promise.race([iterable.next(), stopSignal]);
          if (next === STOP) { Promise.resolve(iterable.return?.()).catch(() => {}); break; }
          if (next.done) break;
          const part = next.value;
          if (part.type === 'text') { text += part.text; emit({ type: 'text', text: part.text }); }
          else if (part.type === 'tool') calls.push({ id: part.id || `call_${round}_${calls.length}`, name: String(part.name || ''), input: part.input && typeof part.input === 'object' ? part.input : {} });
        }
        if (runState.stopped) {
          if (text.trim()) transcript.push({ role: 'assistant', content: text });
          return { stopped: true, steps, applied, planRounds };
        }
        transcript.push({
          role: 'assistant', content: text.trim() ? text : null,
          ...(calls.length ? { tool_calls: calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.input) } })) } : {}),
        });
        if (!calls.length) return { stopped: false, steps, applied, planRounds };
        let plan = null;
        for (const call of calls) {
          if (runState.stopped) { transcript.push({ role: 'tool', tool_call_id: call.id, content: 'Not run: the user stopped the assistant.' }); continue; }
          if (call.name === 'apply_plan') {
            if (plan) { transcript.push({ role: 'tool', tool_call_id: call.id, content: 'Error: a plan was already given in this reply. One apply_plan per reply.' }); continue; }
            plan = call;
            continue;
          }
          if (!PLAN_TOOL_NAMES.has(call.name)) {
            transcript.push({ role: 'tool', tool_call_id: call.id, content: `Error: there is no tool called ${call.name}. In planning mode the workbook is changed only through apply_plan.` });
            continue;
          }
          // A read while planning runs at once and is shown as a step, as in the step-by-step loop.
          const step = { id: call.id, name: call.name, args: call.input, status: 'running', ...(safeDescribe(describe, call)) };
          steps.push(step);
          emit({ type: 'step', step: { ...step } });
          const result = await safeRun(run, { name: call.name, args: call.input }, control);
          step.status = result.ok ? 'done' : 'error';
          if (!result.ok) step.error = String(result.content).replace(/^Error:\s*/, '');
          emit({ type: 'step', step: { ...step } });
          transcript.push({ role: 'tool', tool_call_id: call.id, content: result.content });
        }
        if (!plan) continue;
        // The plan: validated whole, asked about once, applied in order.
        planRounds++;
        const error = validatePlan(wb, env, plan.input);
        if (error) {
          transcript.push({ role: 'tool', tool_call_id: plan.id, content: `Error: the plan was not applied. ${error}` });
          emit({ type: 'plan', status: 'invalid', error });
          continue;
        }
        const edits = plan.input.edits.map((e) => ({ tool: e.tool, args: e.args || {} }));
        const described = edits.map((e) => describeEdit(wb, env, e));
        const planStep = {
          id: plan.id, name: 'apply_plan', args: plan.input, status: 'waiting',
          label: `Apply ${edits.length} edit${edits.length === 1 ? '' : 's'}: ${described.map((d) => d.label).join('; ')}`,
          destructive: described.some((d) => d.destructive),
          detail: described.filter((d) => d.detail).map((d) => d.detail).join(' ') || null,
          edits: described,
        };
        steps.push(planStep);
        if (planStep.destructive && (settings().approval || 'destructive') !== 'never') {
          emit({ type: 'plan', status: 'waiting', step: { ...planStep } });
          const allowed = await Promise.race([Promise.resolve(approve(planStep)).then((v) => !!v, () => false), stopSignal]);
          if (!allowed) {
            planStep.status = 'declined';
            emit({ type: 'plan', status: 'declined', step: { ...planStep } });
            transcript.push({ role: 'tool', tool_call_id: plan.id, content: 'The user declined this plan, so nothing in it was applied. Do not try it another way; say what you would have done.' });
            continue;
          }
        }
        planStep.status = 'running';
        emit({ type: 'plan', status: 'running', step: { ...planStep } });
        // Applied one at a time; the first failure stops the rest and says what did and did not happen.
        const results = [];
        let failed = null;
        for (let i = 0; i < edits.length; i++) {
          if (runState.stopped) { failed = { index: i, reason: 'the user stopped the assistant' }; break; }
          const editStep = { id: `${plan.id}_${i}`, name: edits[i].tool, args: edits[i].args, status: 'running', ...described[i] };
          steps.push(editStep);
          emit({ type: 'step', step: { ...editStep } });
          const result = await safeRun(run, { name: edits[i].tool, args: edits[i].args }, control);
          editStep.status = result.ok ? 'done' : 'error';
          if (!result.ok) editStep.error = String(result.content).replace(/^Error:\s*/, '');
          emit({ type: 'step', step: { ...editStep } });
          results.push({ tool: edits[i].tool, ok: result.ok, content: cutText(String(result.content ?? ''), 2000) });
          if (!result.ok) { failed = { index: i, reason: String(result.content).replace(/^Error:\s*/, '') }; break; }
          applied++;
        }
        planStep.status = failed ? 'error' : 'done';
        if (failed) planStep.error = `Edit ${failed.index + 1} failed: ${failed.reason}`;
        emit({ type: 'plan', status: planStep.status, step: { ...planStep } });
        transcript.push({
          role: 'tool', tool_call_id: plan.id,
          content: failed
            ? `The plan stopped at edit ${failed.index + 1} of ${edits.length}: ${failed.reason}. The ${failed.index} edit${failed.index === 1 ? '' : 's'} before it were applied and stay. Fix the failing edit with a new plan for the rest, or tell the user what is blocking you.`
            : `All ${edits.length} edits were applied. Results:\n${results.map((r) => `${r.tool}: ${r.content}`).join('\n')}\nCheck the computed values above and tell the user what changed, naming cells.`,
        });
      }
      return { stopped: false, steps, applied, planRounds };
    } catch (error) {
      return { stopped: runState.stopped, error, steps, applied, planRounds };
    } finally {
      if (running === runState) running = null;
    }
  }

  return {
    get busy() { return !!running; },
    get messages() { return messages; },
    send(text, onEvent) {
      if (running) throw new Error('The assistant is still answering');
      if (messages.length && messages.at(-1).role !== 'assistant') messages.push({ role: 'assistant', content: '(My previous reply did not finish.)' });
      messages.push({ role: 'user', content: userContent(text, snapshot()) });
      return exchange(onEvent);
    },
    stop() { running?.stop(); },
    reset() { running?.stop(); running = null; messages = []; },
  };
}

async function safeRun(run, call, control) {
  try { return await run(call.name, call.args || {}, control); } catch (e) { return { ok: false, content: `Error: ${e?.message || e}` }; }
}

function safeDescribe(describe, call) {
  try { return describe(call.name, call.input) || { label: call.name }; } catch { return { label: call.name }; }
}

const STOP = Symbol('stop');
