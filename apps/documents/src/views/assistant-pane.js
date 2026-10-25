/**
 * The Assistant pane: a conversation beside the pages that can read and change
 * the open document through tools. Each change it makes is one undoable step,
 * and the pane says what it did and where. A change that replaces the person's
 * own words asks first.
 *
 * The pane, its button on the Home tab and the floating button beside the
 * pages are offered only where the AI service is available.
 */
import { el, isComposing, MOD_KEY, shortcutCode } from '../ui/dom.js';
import { toast } from '../ui/toast.js';
import * as P from '../lib/puter.js';
import { createAgent, createModelPicker } from '@fusion-office/ai-client';
import { SUGGESTIONS } from '../lib/assistant.js';
import { TOOLS, SYSTEM_PROMPT, changesDocument, describeCallFor, documentSnapshot, runTool } from '../lib/assistant-tools.js';
import { sidePane, hint } from './review-ui.js';
import { commandIconEl } from '../ui/ribbon.js';

const words = text => (String(text).trim().match(/\S+/gu) || []).length;
const plural = (n, one, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

const PROMPTS = {
  improve: 'Improve the writing of the selection. Keep its meaning and length.',
  grammar: 'Fix the spelling and grammar of the selection.',
  shorten: 'Make the selection shorter while keeping its meaning.',
  summarize: 'Summarize the selection in a few sentences.',
};

const STATUS_TEXT = {
  running: 'Working…',
  done: 'Done',
  error: 'Failed',
  declined: 'Skipped',
  skipped: 'Stopped',
};

export function createAssistantPane({ editor, pkg, error, available = () => P.canUseAi(), chat = (messages, options) => P.aiChatStream(messages, options) }) {
  let busy = false, currentTurn = null, refused = null;

  const pane = sidePane({ title: 'Assistant', label: 'Assistant pane', className: 'as-pane', onOpen: () => { renderContext(); renderEmpty(); fab.setAttribute('aria-expanded', 'true'); titleButton.setAttribute('aria-pressed', 'true'); }, onClose: () => { fab.setAttribute('aria-expanded', 'false'); titleButton.setAttribute('aria-pressed', 'false'); agent.stop(); editor()?.focus(); } });
  pane.heading.prepend(el('span.as-mark', { 'aria-hidden': 'true' }, commandIconEl('assistant', 16)));
  const newChat = el('button.btn.btn-ghost.btn-sm.as-new', { type: 'button', onclick: () => newChatNow() }, 'New chat');
  pane.heading.after(newChat);
  const modelPicker = createModelPicker();
  if (modelPicker) newChat.after(modelPicker);

  const log = el('div.as-log', { role: 'log', 'aria-label': 'Conversation with the assistant', tabIndex: -1 });
  const empty = el('div.as-empty');
  const context = el('p.as-context', { 'aria-live': 'polite' });
  const input = el('textarea.input.as-input', { rows: 3, placeholder: 'Ask the assistant to read or change this document…', 'aria-label': 'Message the assistant', enterKeyHint: 'send' });
  const send = el('button.btn.btn-primary.as-send', { type: 'submit', 'aria-label': 'Send', title: 'Send (Enter)' }, 'Send');
  const form = el('form.as-form', { onsubmit: e => { e.preventDefault(); if (busy) stop(); else submit(input.value); } }, context, el('div.as-box', {}, input, send), el('p.as-disclaimer', {}, 'The assistant works on the open document through tools. Every change can be undone. Replies can be wrong: check them before you use them.'));
  input.addEventListener('keydown', e => {
    if (isComposing(e)) return;
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (!busy) submit(input.value); }
  });
  pane.body.append(log, form);

  const titleButton = el('button.ed-pill.as-title-button', { type: 'button', 'aria-label': 'Assistant', title: `Assistant (${MOD_KEY}+Shift+I)`, 'aria-pressed': 'false', hidden: true, onclick: () => toggle() }, commandIconEl('assistant', 16));
  titleButton.addEventListener('mousedown', e => e.preventDefault());
  const fab = el('button.as-fab', { type: 'button', 'aria-label': 'Assistant', title: `Assistant (${MOD_KEY}+Shift+I)`, 'aria-expanded': 'false', hidden: true, onclick: () => toggle() }, commandIconEl('assistant', 20));
  fab.addEventListener('mousedown', e => e.preventDefault());
  const keys = new AbortController();
  window.addEventListener('keydown', e => {
    if (e.defaultPrevented || isComposing(e) || !(e.ctrlKey || e.metaKey) || !e.shiftKey || e.altKey || shortcutCode(e) !== 'KeyI' || !editor()) return;
    e.preventDefault(); toggle();
  }, { signal: keys.signal });

  /* ---- The agent ---- */

  const agent = createAgent({
    chat: (messages, options) => chat(messages, options),
    tools: TOOLS,
    system: SYSTEM_PROMPT,
    snapshot: () => documentSnapshot(editor(), { docName: pkg()?.name }),
    settings: () => ({ approval: 'destructive' }),
    changes: name => changesDocument(name),
    describe: (name, args) => describeCallFor(editor(), name, args),
    runTool: (name, args) => {
      const engine = editor();
      if (!engine) return { ok: false, content: 'Error: no document is open.' };
      if (changesDocument(name) && (pkg()?.readOnly || engine.viewOnly)) return { ok: false, content: 'Error: the document is read-only.' };
      return runTool(engine, name, args);
    },
    approve: step => askApproval(step),
  });

  /* ---- What the person can see ---- */

  function selection() {
    const engine = editor(); if (!engine) return null;
    if (engine.session.path !== null) return null;
    const [start, end] = engine.model.range;
    return start === end ? null : { start, end, text: engine.model.text.slice(start, end) };
  }

  function renderContext() {
    const s = selection();
    context.textContent = !editor() ? 'No document is open.' : s
      ? `Selected: ${plural(words(s.text), 'word')}. The assistant can work on the selection or the whole document.`
      : 'The assistant can read and change the whole document.';
  }

  function renderEmpty() {
    if (log.querySelector('.as-message')) { empty.remove(); return; }
    const list = selection() ? SUGGESTIONS.selection : SUGGESTIONS.document;
    empty.replaceChildren(el('p.as-empty-title', {}, 'How can I help with this document?'),
      el('div.as-suggestions', {}, ...list.map(s => el('button.as-suggestion', { type: 'button', onclick: () => submit(s.id ? PROMPTS[s.id] : s.ask) }, s.label))),
      hint('Ask in plain words. The assistant reads what it needs and changes the document for you.'));
    log.append(empty);
  }

  const message = (who, ...children) => { empty.remove(); const node = el(`div.as-message.is-${who}`, {}, ...children); log.append(node); node.scrollIntoView?.({ block: 'nearest' }); return node; };

  /* ---- Sending ---- */

  async function submit(text) {
    const request = String(text || '').trim();
    if (!request || busy) return;
    if (!editor()) { toast('Open a document first.', { icon: 'info' }); return; }
    input.value = '';
    message('me', el('p', {}, request));
    currentTurn = message('assistant', el('div.as-answer'));
    const answer = currentTurn.querySelector('.as-answer');
    let said = '';
    const steps = [];
    const rows = new Map();
    busy = true; syncSend();
    try {
      const result = await agent.send(request, event => {
        if (event.type === 'text') {
          said += event.text;
          answer.replaceChildren(...paragraphs(said));
        } else if (event.type === 'step') {
          const known = steps.findIndex(s => s.id === event.step.id);
          if (known < 0) { steps.push(event.step); rows.set(event.step.id, stepRow(event.step)); currentTurn.append(rows.get(event.step.id)); }
          else { steps[known] = event.step; updateStep(rows.get(event.step.id), event.step); }
        }
      });
      if (result.error) failure(answer, result.error);
      else if (!said.trim() && !steps.length) failure(answer, 'The assistant did not answer.');
      if (steps.some(s => s.changed)) currentTurn.append(undoRow());
    } catch (e) {
      failure(answer, e);
    } finally {
      busy = false; syncSend(); currentTurn = null;
    }
  }

  function syncSend() {
    send.textContent = busy ? 'Stop' : 'Send';
    send.setAttribute('aria-label', busy ? 'Stop' : 'Send');
    send.title = busy ? 'Stop' : 'Send (Enter)';
  }

  function stop() { agent.stop(); }

  function newChatNow() {
    agent.reset();
    log.replaceChildren();
    renderEmpty();
    input.focus();
  }

  function paragraphs(text) {
    return String(text).split(/\n{2,}/).map(part => part.trim()).filter(Boolean).map(part => el('p', {}, part.replace(/\n/g, ' ')));
  }

  function failure(answer, reason) {
    const text = reason?.message || String(reason || '');
    answer.replaceChildren();
    answer.append(el('p.as-error', {}, text && text.length < 200 && !/AI service|could not answer/i.test(text) ? text : 'The assistant could not answer. Check that the local gateway and a model are running.'));
  }

  function stepRow(step) {
    return el('div.as-step', { 'data-step': step.id },
      el('span.as-step-icon', { 'aria-hidden': 'true' }, step.status === 'running' ? '•' : step.status === 'error' ? '!' : '✓'),
      el('span.as-step-label', {}, step.label || step.name),
      el('span.as-step-status', { role: 'status' }, STATUS_TEXT[step.status] || step.status));
  }

  function updateStep(row, step) {
    if (!row) return;
    row.dataset.status = step.status;
    row.querySelector('.as-step-icon').textContent = step.status === 'running' ? '•' : step.status === 'error' ? '!' : '✓';
    row.querySelector('.as-step-status').textContent = STATUS_TEXT[step.status] || step.status;
    if (step.error) row.title = step.error;
  }

  function undoRow() {
    const applied = el('span.as-applied', { role: 'status' }, 'Changes made');
    const undo = el('button.btn.btn-ghost.btn-sm', { type: 'button', onclick: () => { const engine = editor(); if (!engine) return; engine.undo(); undo.disabled = true; applied.textContent = 'Undone'; } }, 'Undo');
    return el('div.as-actions', {}, applied, undo);
  }

  /** A change that replaces the person's words asks first; the tool waits for the answer. */
  function askApproval(step) {
    return new Promise(resolve => {
      const turn = currentTurn;
      if (!turn) { resolve(false); return; }
      const answer = ok => { card.remove(); refused = null; resolve(ok); };
      const card = el('div.as-approval', {},
        el('p', {}, `${step.label || step.name}. Allow this change?`),
        el('div.as-actions', {},
          el('button.btn.btn-primary.btn-sm', { type: 'button', onclick: () => answer(true) }, 'Allow'),
          el('button.btn.btn-ghost.btn-sm', { type: 'button', onclick: () => answer(false) }, 'Skip')));
      refused = answer;
      turn.append(card);
      card.scrollIntoView?.({ block: 'nearest' });
    });
  }

  function toggle() { if (!available()) return; pane.toggle(); if (pane.isOpen) queueMicrotask(() => input.focus()); }

  return {
    pane, fab, titleButton,
    get available() { return available(); },
    open() { if (!available()) return; pane.open(); queueMicrotask(() => input.focus()); },
    toggle,
    refresh() {
      fab.hidden = titleButton.hidden = !available() || !editor();
      if (pane.isOpen && !busy) { renderContext(); if (!log.querySelector('.as-message')) renderEmpty(); }
    },
    commands: {
      assistant: () => toggle(),
      assistantAvailable: () => available(),
    },
    extendMenu(id) {
      if (!['tools', 'view'].includes(id) || !available()) return [];
      return [{ separator: true }, { label: 'Assistant', icon: 'assistant', shortcut: `${MOD_KEY}+Shift+I`, checked: id === 'view' ? pane.isOpen : undefined, disabled: !editor(), onSelect: () => toggle() }];
    },
    destroy() { refused?.(false); keys.abort(); agent.stop(); pane.destroy(); },
  };
}
