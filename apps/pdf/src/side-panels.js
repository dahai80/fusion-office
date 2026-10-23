import { el, icon, iconButton, button, formatBytes } from './lib/ui.js';

/**
 * The Attachments panel: files carried inside the PDF, each with Save and Remove, and a
 * button to attach another file.
 */
export function createAttachmentsPanel({ onAdd, onSave, onRemove, canEdit }) {
  const list = el('ul', { class: 'attachment-list', 'aria-label': 'Attached files' });
  const empty = el(
    'p',
    { class: 'panel-empty muted' },
    'No files are attached to this PDF. Attach a file to keep it with the document.',
  );
  const addButton = button('Attach a file…', 'Plus', () => onAdd(), 'btn panel-action');
  const root = el('div', { class: 'attachments-panel' }, addButton, empty, list);
  let generation = 0;
  return {
    el: root,
    count: 0,
    /** List the attachments PDF.js finds; resolves with their number. */
    async load(pdf, { isCurrent = () => true } = {}) {
      const token = ++generation;
      let entries = [];
      try {
        const found = await pdf.getAttachments();
        if (found) entries = found instanceof Map ? [...found] : Object.entries(found);
      } catch {
        entries = [];
      }
      if (token !== generation || !isCurrent()) return null;
      this.count = entries.length;
      empty.hidden = entries.length > 0;
      addButton.disabled = !canEdit();
      list.replaceChildren(
        ...entries.map(([key, info]) =>
          el(
            'li',
            { class: 'attachment-row' },
            el('span', { class: 'attachment-icon', 'aria-hidden': 'true' }, icon('FileText', 18)),
            el(
              'span',
              { class: 'attachment-text' },
              el(
                'span',
                { class: 'attachment-name', title: info.filename || key },
                info.filename || key,
              ),
              info.description && el('span', { class: 'attachment-meta muted' }, info.description),
            ),
            iconButton(`Save ${info.filename || key}`, 'Download', () =>
              onSave(key, info.filename || key),
            ),
            iconButton(
              `Remove ${info.filename || key}`,
              'Trash2',
              () => onRemove(key, info.filename || key),
              {
                disabled: !canEdit(),
              },
            ),
          ),
        ),
      );
      return entries.length;
    },
  };
}

/**
 * The Layers panel: the PDF's optional content groups with a visibility switch each. The
 * switches change what is shown, not the file, as in desktop PDF readers.
 */
export function createLayersPanel({ onToggle }) {
  const tree = el('ul', { class: 'layer-list', role: 'list', 'aria-label': 'Layers' });
  const root = el(
    'div',
    { class: 'layers-panel' },
    el('p', { class: 'panel-note muted' }, 'Showing or hiding a layer changes the view only.'),
    tree,
  );
  let config = null;
  function row(id, depth) {
    const group = config.getGroup(id);
    if (!group) return null;
    const input = el('input', {
      type: 'checkbox',
      checked: group.visible !== false,
      onchange: () => onToggle(id, input.checked),
    });
    return el(
      'li',
      { class: 'layer-row', style: `--depth:${depth}` },
      el('label', {}, input, icon('Layers', 15), el('span', {}, group.name || 'Unnamed layer')),
    );
  }
  function walk(order, depth = 0) {
    const rows = [];
    for (const entry of order || []) {
      if (typeof entry === 'string') rows.push(row(entry, depth));
      else if (entry && typeof entry === 'object') {
        if (entry.name)
          rows.push(el('li', { class: 'layer-heading', style: `--depth:${depth}` }, entry.name));
        rows.push(...walk(entry.order, depth + 1));
      }
    }
    return rows.filter(Boolean);
  }
  return {
    el: root,
    /** Show the layers of a configuration; resolves with whether there are any. */
    show(next) {
      config = next;
      const groups = config ? [...config] : [];
      if (!groups.length) {
        tree.replaceChildren();
        return false;
      }
      const order = config.getOrder?.();
      const rows = order?.length ? walk(order) : groups.map(([id]) => row(id, 0));
      tree.replaceChildren(...rows);
      return true;
    },
  };
}

export { formatBytes };
