import { el, clear, requireValue } from '../lib/dom.js';
import { icon } from './icons.js';
import { store, taskChecklist, checklistProgress } from '../lib/store.js';
import { debounce } from '../lib/util.js';
import { progressBar } from './bits.js';
import { toast } from './toast.js';
import { initListReorder } from './reorder.js';
import { record } from './history.js';
import * as AI from '@fusion-office/ai-client';

/**
 * Checklist section of the task sheet: the unit of granularity below a card,
 * without becoming a subtask hierarchy. Items carry text and a done flag,
 * nothing else.
 *
 * Like the rest of the sheet this keeps its own DOM in step instead of
 * re-rendering on store events, so a text edit never loses the caret: only
 * add, delete, and reorder rebuild the list.
 */
export function checklistSection({ projectId, task }) {
  const taskId = task.id;
  const items = () => taskChecklist(task);

  const list = el('div.checklist', { role: 'list' });
  const count = el('span.checklist-count');
  const progressWrap = el('div.checklist-progress');
  const heading = el('span.label', {}, 'Checklist');

  const addInput = el('input.input.checklist-add', {
    type: 'text',
    placeholder: 'Add an item',
    'aria-label': 'New checklist item',
    maxLength: 200,
    onkeydown: (e) => {
      if (e.isComposing) return;
      if (e.key === 'Enter') { e.preventDefault(); submit(); }
    },
  });

  const addForm = el('form.checklist-add-row', {
    onsubmit: (e) => { e.preventDefault(); submit(); },
  },
    addInput,
    el('button.btn.btn-ghost.btn-sm', { type: 'submit', html: icon('plus', 14, 2.2) }, ' Add')
  );

  const aiStatus = el('p.form-hint.ai-status', { role: 'status' });
  const aiButton = el('button.btn.btn-ghost.btn-sm', {
    type: 'button',
    html: icon('sparkle', 14, 2.2),
    title: 'Break this task into checklist items with the local AI',
    onclick: () => breakdown(),
  }, ' Break down with AI');

  async function breakdown() {
    if (aiButton.disabled) return;
    if (!AI.isConfigured()) {
      aiStatus.textContent = 'AI is not configured. Set VITE_FUSION_GATEWAY_KEY for the gateway.';
      return;
    }
    aiButton.disabled = true;
    aiStatus.textContent = 'Thinking…';
    try {
      const prompt = [
        'Break the following task into 3 to 7 short checklist items.',
        'Reply with JSON only: {"items":["...","..."]}.',
        `Task: ${task.title}`,
        task.description ? `Details: ${task.description}` : '',
      ].join('\n');
      const reply = await AI.jsonChat({
        messages: [
          { role: 'system', content: 'You split project tasks into concrete, verifiable steps. Reply with JSON only.' },
          { role: 'user', content: prompt },
        ],
      });
      const items = Array.isArray(reply?.items) ? reply.items : [];
      const clean = items
        .map((item) => String(item || '').trim().slice(0, 200))
        .filter(Boolean)
        .slice(0, 8);
      if (!clean.length) {
        aiStatus.textContent = 'The assistant returned no steps. Try again.';
        return;
      }
      for (const text of clean) store.addChecklistItem(projectId, taskId, text);
      render();
      aiStatus.textContent = `${clean.length} step${clean.length === 1 ? '' : 's'} added.`;
      console.log('[pm] ai breakdown added', clean.length, 'items');
    } catch (error) {
      console.warn('[pm] ai breakdown failed', error);
      aiStatus.textContent = 'The assistant could not answer. Check that fusion-gateway is running.';
    } finally {
      aiButton.disabled = false;
    }
  }

  function submit() {
    const text = requireValue(addInput, 'An item needs some text.');
    if (!text) return;
    store.addChecklistItem(projectId, taskId, text);
    addInput.value = '';
    render();
    // Rapid entry: stay in the field, newest item in view.
    addInput.focus();
    list.lastElementChild?.scrollIntoView({ block: 'nearest' });
  }

  function renderHeader() {
    const { done, total } = checklistProgress(task);
    count.textContent = total ? `${done}/${total}` : '';
    clear(progressWrap);
    if (total) {
      progressWrap.append(progressBar(done, total, {
        label: `Checklist: ${done} of ${total} done`,
      }));
    }
    heading.textContent = 'Checklist';
  }

  function itemRow(item) {
    const box = el('input.checklist-box', {
      type: 'checkbox',
      checked: !!item.done,
      'aria-label': item.text,
      onchange: () => {
        store.updateChecklistItem(projectId, taskId, item.id, { done: box.checked });
        row.classList.toggle('done', box.checked);
        text.classList.toggle('done', box.checked);
        renderHeader();
      },
    });

    const text = el('input.checklist-text', {
      type: 'text',
      value: item.text,
      maxLength: 200,
      'aria-label': `Item: ${item.text}`,
      className: `checklist-text${item.done ? ' done' : ''}`,
      oninput: debounce(() => {
        const v = text.value.trim();
        // An emptied field is a mistake, not a request for a blank item;
        // the last non-empty text stays until something replaces it.
        if (v) store.updateChecklistItem(projectId, taskId, item.id, { text: v });
      }, 400),
      onblur: () => { if (!text.value.trim()) text.value = item.text; },
      onkeydown: (e) => {
        if (e.isComposing) return;
        if (e.key === 'Enter') { e.preventDefault(); addInput.focus(); }
      },
    });

    const handle = el('button.checklist-grip.drag-handle', {
      type: 'button',
      html: icon('grip', 14, 2),
      'aria-label': `Reorder ${item.text}. Alt with up or down arrow moves it.`,
      title: 'Drag to reorder',
      onkeydown: (e) => {
        if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
        e.preventDefault();
        const at = items().findIndex((i) => i.id === item.id);
        const to = e.key === 'ArrowUp' ? at - 1 : at + 1;
        if (to < 0 || to >= items().length) return;
        moveItem(item, at, to);
        list.querySelector(`[data-id="${item.id}"] .checklist-grip`)?.focus();
      },
    });

    const row = el('div.checklist-item', {
      dataset: { id: item.id },
      role: 'listitem',
      className: `checklist-item${item.done ? ' done' : ''}`,
    },
      handle,
      box,
      text,
      el('button.icon-btn.small.checklist-del', {
        type: 'button',
        html: icon('trash', 14, 2),
        'aria-label': `Delete ${item.text}`,
        onclick: () => {
          const at = items().findIndex((i) => i.id === item.id);
          const snapshot = { ...item };
          store.deleteChecklistItem(projectId, taskId, item.id);
          render();
          toast('Checklist item deleted', {
            icon: 'trash',
            action: {
              label: 'Undo',
              onClick: () => {
                store.addChecklistItem(projectId, taskId, snapshot.text);
                const restored = items()[items().length - 1];
                store.updateChecklistItem(projectId, taskId, restored.id, { done: snapshot.done });
                store.moveChecklistItem(projectId, taskId, restored.id, at);
                render();
              },
            },
          });
        },
      })
    );
    return row;
  }

  function render() {
    clear(list);
    for (const item of items()) list.append(itemRow(item));
    renderHeader();
  }

  render();

  /** Moving an item is a gesture like any other: it goes on the undo stack. */
  function moveItem(item, from, toIndex) {
    store.moveChecklistItem(projectId, taskId, item.id, toIndex);
    render();
    record(projectId, {
      label: `move of “${item.text}”`,
      undo: () => { store.moveChecklistItem(projectId, taskId, item.id, from); render(); },
      redo: () => { store.moveChecklistItem(projectId, taskId, item.id, toIndex); render(); },
    });
  }

  const reorder = initListReorder(list, {
    itemSelector: '.checklist-item',
    handleSelector: '.drag-handle',
    onReorder: (id, toIndex) => {
      const from = items().findIndex((i) => i.id === id);
      const item = items().find((i) => i.id === id);
      if (!item || from === toIndex) { render(); return; }
      moveItem(item, from, toIndex);
    },
  });

  const section = el('div.field.checklist-field', {},
    el('div.row.checklist-head', {}, heading, count, progressWrap),
    list,
    addForm,
    el('div.row.checklist-ai', {}, aiButton),
    aiStatus
  );
  section.destroy = () => reorder.destroy();
  return section;
}
