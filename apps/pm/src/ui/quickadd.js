import { el, clear } from '../lib/dom.js';
import { icon } from './icons.js';
import { store, LABEL_COLORS } from '../lib/store.js';
import { parseQuickAdd, QUICK_ADD_HINTS } from '../lib/quickadd.js';
import { fieldId, debounce } from '../lib/util.js';
import { fmtShort, fmtLong, isValidISO, todayISO } from '../lib/dates.js';
import { openModal } from './modal.js';
import { toast } from './toast.js';
import { openTaskSheet } from './tasksheet.js';
import { avatar } from './bits.js';
import * as AI from '@fusion-office/ai-client';

/**
 * Quick add: the shared parsing UI (live chips under a composer) and the
 * global one-line composer that can capture a task from anywhere.
 *
 * Nothing is guessed silently — every token the parser claimed shows up as a
 * chip, and every chip has a "keep as text" escape for the title that
 * legitimately contains a `#` or an `@`.
 */

/**
 * A chip strip bound to one input. `update(text)` re-parses and redraws;
 * `parse(text)` returns the parse the strip is showing.
 *
 * quickAddChips({ doc, onChange }) → { node, update, parse, reset }
 */
export function quickAddChips({ doc, onChange }) {
  const ignore = new Set(); // raw token text the user chose to keep as text
  const node = el('div.qa-chips');

  const context = () => {
    const d = doc();
    return { labels: d?.labels ?? [], members: d?.members ?? [], ignore };
  };

  const parse = (text) => parseQuickAdd(text, context());

  function chipFor(token) {
    const body = token.kind === 'due'
      ? [el('span.qa-chip-ic', { html: icon('calendar', 12, 2.2), 'aria-hidden': 'true' }),
        fmtShort(token.value)]
      : token.kind === 'priority'
        ? [el('span.qa-chip-ic', { html: icon(token.value, 12, 2.2), 'aria-hidden': 'true' }),
          token.value]
        : token.kind === 'assignee'
          ? [avatar(token.member, 16), token.member.name]
          : token.kind === 'label'
            ? [el('span.dot', { style: { background: token.color }, 'aria-hidden': 'true' }), token.label]
            : [el('span.qa-chip-ic', { html: icon('plus', 12, 2.6), 'aria-hidden': 'true' }), token.label];

    return el('span.qa-chip', {
      className: `qa-chip qa-chip-${token.kind}`,
      title: token.kind === 'due' ? fmtLong(token.value) : undefined,
    },
      ...body,
      el('button.qa-chip-x', {
        type: 'button',
        html: icon('x', 11, 2.6),
        title: `Keep “${token.raw}” as text`,
        'aria-label': `Keep ${token.raw} as text`,
        onclick: () => {
          ignore.add(token.raw.toLowerCase());
          onChange?.();
        },
      })
    );
  }

  return {
    node,
    parse,
    reset() { ignore.clear(); clear(node); },
    /** Show tokens from an outside parse (the AI path) with the same chips. */
    show(tokens) {
      clear(node);
      if (tokens.length) node.append(...tokens.map(chipFor));
      node.hidden = !tokens.length;
    },
    /** Redraw for `text`, and hand back the parse it is showing. */
    update(text) {
      const parsed = parse(text);
      clear(node);
      if (parsed.tokens.length) node.append(...parsed.tokens.map(chipFor));
      node.hidden = !parsed.tokens.length;
      return parsed;
    },
  };
}

/**
 * The hint line, shown once under an empty quick-add composer.
 *
 * The tokens are separated by a space rather than by commas: each one is a
 * padded pill, so a comma after it landed a chip's width away from the word it
 * belonged to and read as " ,". For the same reason the sentence ends on a
 * word instead of on punctuation the last pill would push off. The space is a
 * real text node, because a margin between two pills is air but not a line
 * break, and this line has to wrap inside a 282px board column.
 */
export function quickAddHint() {
  return el('p.form-hint.qa-hint', {},
    'Type ',
    ...QUICK_ADD_HINTS.flatMap((h, i) => [
      i ? ' ' : '',
      el('code.qa-token', { title: h.means }, h.token),
    ]),
    ' in the title. What you see below is what gets saved.'
  );
}

/**
 * Turn a parse into a task. New labels named by `#token` are created first,
 * so the task never references a label that does not exist.
 */
export function applyQuickAdd(projectId, columnId, parsed) {
  const labelIds = [...parsed.labelIds];
  for (const name of parsed.newLabels) {
    const d = store.getDoc(projectId);
    const clean = name.trim().slice(0, 40);
    if (!clean) continue;
    const existing = d.labels.find((l) => l.name.toLowerCase() === clean.toLowerCase());
    const label = existing ?? store.addLabel(projectId, {
      name: clean,
      // Cycle rather than pick at random: two labels made in a row should
      // not be able to come out the same colour.
      color: LABEL_COLORS[d.labels.length % LABEL_COLORS.length],
    });
    labelIds.push(label.id);
  }
  return store.addTask(projectId, columnId, {
    title: parsed.title.slice(0, 200),
    dueDate: parsed.dueDate,
    priority: parsed.priority,
    labelIds,
    assigneeIds: parsed.assigneeIds,
  });
}

/** Where the last quick add landed, so the next one starts there. */
let lastUsed = { projectId: null, columnId: null };

export function rememberQuickAddTarget(projectId, columnId) {
  lastUsed = { projectId, columnId };
}

/**
 * The global composer: capture a task without navigating first. Project and
 * column start where the last one landed (or on the project being looked at).
 */
export function openQuickAdd({ projectId = null } = {}) {
  const projects = store.projects.filter((p) => !p.archived);
  if (!projects.length) {
    toast('Create a project first', { icon: 'folder' });
    return null;
  }

  const wanted = projectId ?? lastUsed.projectId;
  let current = projects.find((p) => p.id === wanted)?.id ?? projects[0].id;
  let doc = null;
  let added = [];

  const projectId_ = fieldId('qa-project');
  const columnId_ = fieldId('qa-column');

  const projectSelect = el('select.input', {
    id: projectId_,
    onchange: () => { current = projectSelect.value; load(); },
  }, projects.map((p) => el('option', { value: p.id, selected: p.id === current }, p.name)));

  const columnSelect = el('select.input', { id: columnId_ });

  const input = el('input.input.qa-input', {
    type: 'text',
    placeholder: 'What needs doing?',
    'aria-label': 'Task title, with optional date, priority, label, and assignee',
    autocomplete: 'off',
    maxLength: 300,
    oninput: () => { refresh(); scheduleAiParse(); },
    onkeydown: (e) => {
      if (e.isComposing) return;
      if (e.key === 'Enter') { e.preventDefault(); submit(); }
    },
  });

  const chips = quickAddChips({ doc: () => doc, onChange: () => refresh() });
  const recent = el('div.qa-recent');
  const addBtn = el('button.btn.btn-primary', { type: 'button', disabled: true, onclick: () => submit() }, 'Add task');

  // Natural-language parse from the gateway. The mechanical chips stay live
  // and instant; when the AI answers, its tokens replace them, and submit
  // prefers the AI parse only for the line it was computed from. Anything
  // else — not configured, a rejected reply, a gateway failure — leaves the
  // mechanical parse untouched.
  let aiParse = null;
  let aiSeq = 0;
  const scheduleAiParse = debounce(runAiParse, 500);

  function aiTokens(parsed) {
    return parsed.dueDate
      ? [{ kind: 'due', raw: parsed.dueDate, value: parsed.dueDate, label: parsed.dueDate }]
      : [];
  }

  function acceptAiParse(reply, text) {
    const title = String(reply?.title ?? '').trim();
    if (!title) return null;
    const wanted = String(reply?.column ?? '').trim().toLowerCase();
    const column = doc.columns.find((c) => c.name.toLowerCase() === wanted);
    if (!column) return null;
    let due = reply?.due_date;
    if (due != null) {
      due = String(due).slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(due) || !isValidISO(due)) return null;
    } else {
      due = null;
    }
    return { source: text, title: title.slice(0, 200), columnId: column.id, dueDate: due };
  }

  async function runAiParse() {
    if (!doc || !AI.isConfigured()) return;
    const text = input.value.trim();
    if (!text) { aiParse = null; return; }
    const seq = ++aiSeq;
    try {
      const reply = await AI.jsonChat({
        messages: [
          { role: 'system', content: 'You turn one line of natural language into a task. Reply with JSON only.' },
          { role: 'user', content: [
            'Turn the line below into a task.',
            'Reply with JSON only: {"title":"...","column":"<one of the column names below>","due_date":"YYYY-MM-DD" or null}.',
            `Columns: ${doc.columns.map((c) => c.name).join(', ')}.`,
            `Today is ${todayISO()}.`,
            `Line: ${text}`,
          ].join('\n') },
        ],
      });
      if (seq !== aiSeq || input.value.trim() !== text) return;
      aiParse = acceptAiParse(reply, text);
      if (aiParse) chips.show(aiTokens(aiParse));
      else console.warn('[pm] quick add AI parse rejected, keeping the mechanical one');
    } catch (error) {
      if (seq === aiSeq) aiParse = null;
      console.warn('[pm] quick add AI parse failed, keeping the mechanical one', error);
    }
  }

  function refresh() {
    const parsed = chips.update(input.value);
    if (aiParse && input.value.trim() !== aiParse.source) aiParse = null;
    addBtn.disabled = !parsed.title.trim();
    return parsed;
  }

  function renderRecent() {
    clear(recent);
    if (!added.length) return;
    recent.append(el('p.form-hint', {},
      `Added ${added.length} ${added.length === 1 ? 'task' : 'tasks'}:`));
    // The last few, newest first — enough to confirm, not a second list view.
    for (const item of added.slice(-3).reverse()) {
      recent.append(el('button.qa-recent-row', {
        type: 'button',
        onclick: () => {
          openTaskSheet(item.projectId, item.taskId);
          modal.close();
        },
      },
        el('span.qa-recent-ic', { html: icon('check', 13, 2.6), 'aria-hidden': 'true' }),
        el('span.qa-recent-title', {}, item.title),
        el('span.qa-recent-open', {}, 'Open')
      ));
    }
  }

  function load() {
    columnSelect.replaceChildren(el('option', {}, 'Loading…'));
    columnSelect.disabled = true;
    doc = null;
    refresh();
    store.loadProject(current).then((loaded) => {
      if (current !== loaded.id) return; // the picker moved on
      doc = loaded;
      const preferred = lastUsed.projectId === current ? lastUsed.columnId : null;
      columnSelect.replaceChildren(...loaded.columns.map((c) => el('option', {
        value: c.id,
        selected: c.id === preferred,
      }, c.name)));
      columnSelect.disabled = false;
      refresh();
    }).catch(() => {
      columnSelect.replaceChildren(el('option', {}, 'Could not load'));
      toast('Could not load that project. Check your connection', { icon: 'cloudOff' });
    });
  }

  function submit() {
    if (!doc) return;
    let parsed = refresh();
    if (!parsed.title.trim()) { input.focus(); return; }
    let columnId = columnSelect.value || doc.columns[0]?.id;
    if (!columnId) return;
    if (aiParse && input.value.trim() === aiParse.source) {
      parsed.title = aiParse.title;
      parsed.dueDate = aiParse.dueDate;
      columnId = aiParse.columnId;
      columnSelect.value = aiParse.columnId;
      chips.show(aiTokens(aiParse));
      console.log('[pm] quick add used the AI parse:', aiParse.title);
    }
    const task = applyQuickAdd(current, columnId, parsed);
    rememberQuickAddTarget(current, columnId);
    added = [...added, { projectId: current, taskId: task.id, title: task.title }];
    input.value = '';
    chips.reset();
    aiParse = null;
    aiSeq += 1;
    refresh();
    renderRecent();
    // Enter adds and stays put: capture is usually more than one thought.
    input.focus();
  }

  const content = el('div.qa-body', {},
    el('div.qa-row', {},
      el('div.field.grow', {}, el('label.label', { htmlFor: projectId_ }, 'Project'), projectSelect),
      el('div.field.grow', {}, el('label.label', { htmlFor: columnId_ }, 'Column'), columnSelect)
    ),
    input,
    chips.node,
    quickAddHint(),
    recent,
    el('div.row.row-end', {},
      el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, 'Done'),
      addBtn
    )
  );

  const modal = openModal({ title: 'Quick add', content, dismissOnBack: true });
  load();
  setTimeout(() => input.focus(), 30);
  return modal;
}
