import { el, isComposing } from '../ui/dom.js';
import { iconEl } from '../ui/icons.js';
import { xmlAttributeText } from '../engine/text-limits.js';
import { aiAvailable, aiChat } from '../lib/puter.js';
import { altTextPrompt, cleanSuggestion } from '../lib/alt-text-ai.js';

/**
 * The Alt Text pane: a description for people who cannot see the picture or shape (wp:docPr descr,
 * §20.4.2.5), an optional title, and "Mark as decorative" for objects that add nothing to the meaning
 * (the decorative extension, which readers of the file use to skip the object). Changes are saved when
 * the field loses focus, on Ctrl/Cmd+Enter, or when the decorative box changes.
 */
export function createPane(context) {
  const { selected, describe, commands, onClose, kind, editor } = context;
  const description = el('textarea.input.pic-alt-text', { rows: 6, maxLength: 2000, 'aria-label': 'Description', placeholder: 'Describe the object and its context for someone who cannot see it (one or two sentences).' });
  const title = el('input.input', { type: 'text', maxLength: 255, 'aria-label': 'Title (optional)' });
  const decorative = el('input', { type: 'checkbox', id: 'pic-alt-decorative' });
  const counter = el('span.pic-hint', { 'aria-live': 'polite' });
  const target = el('p.pic-hint');
  const suggestStatus = el('p.pic-hint', { 'aria-live': 'polite' });
  const suggest = el('button.btn.btn-outline.btn-sm', { type: 'button', onclick: () => suggestAltText() }, 'Suggest with AI');
  const node = el('aside.pic-pane.pic-alt-pane', { 'aria-label': 'Alt Text pane' },
    el('div.canvas-panel-heading', {}, el('h2', {}, 'Alt Text'), el('button.icon-btn', { type: 'button', 'aria-label': 'Close Alt Text pane', onclick: () => close() }, iconEl('x', 18))),
    el('div.canvas-panel-scroll', {},
      target,
      el('label.pic-field', {}, el('span', {}, 'Description'), description, counter),
      el('div.pic-actions', {}, suggest),
      suggestStatus,
      el('label.pic-field', {}, el('span', {}, 'Title (optional)'), title),
      el('label.pic-check', { htmlFor: 'pic-alt-decorative' }, decorative, 'Mark as decorative'),
      el('p.pic-hint', {}, 'Decorative objects add visual interest but are not informative, like stylistic borders. Screen readers skip them.'),
      el('div.pic-actions', {}, el('button.btn.btn-primary.btn-sm', { type: 'button', onclick: () => save() }, 'Save'))));
  // `owner` is the object the fields describe. Selecting another object while a field still has focus
  // refreshes the pane before the field blurs, so edits are saved to their owner, never to the new selection.
  let shown = null, owner = null, saved = null, suggesting = false;
  const current = () => { const image = selected(); return image ? describe(image) : null; };
  async function save(image = owner) {
    if (!image) return;
    const info = describe(image) || {};
    const next = { description: decorative.checked ? '' : xmlAttributeText(description.value).trim(), title: xmlAttributeText(title.value).trim(), decorative: decorative.checked };
    if (next.description === (info.description || '') && next.title === (info.title || '') && next.decorative === !!info.decorative) return;
    const key = JSON.stringify([image.id, next]);
    if (key === saved) return;
    saved = key;
    await commands.altText(next, image);
  }
  description.addEventListener('input', () => { counter.textContent = `${description.value.length} / 2000`; });
  description.addEventListener('blur', () => save());
  title.addEventListener('blur', () => save());
  description.addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !isComposing(e)) { e.preventDefault(); save(); } });
  decorative.addEventListener('change', () => { description.disabled = decorative.checked; save(); });
  node.addEventListener('keydown', e => { if (e.key === 'Escape' && !isComposing(e) && !e.defaultPrevented) { e.preventDefault(); save(); close(); } });
  /** Ask the AI for a description from the image's context; the user still presses Save. */
  async function suggestAltText() {
    const image = selected(), engine = editor();
    if (!image || !engine || suggesting || !aiAvailable()) return;
    const [a, b] = engine.model.range, text = engine.model.text;
    const inline = engine.session.path === null && b > a && b - a <= 2;
    suggesting = true; suggest.disabled = true;
    suggestStatus.textContent = 'Writing a suggestion…';
    try {
      const suggestion = cleanSuggestion(await aiChat(altTextPrompt({
        name: image.name, width: image.width, height: image.height,
        before: inline ? text.slice(Math.max(0, a - 400), a) : '',
        after: inline ? text.slice(b, b + 400) : '',
      })));
      if (!suggestion) throw new Error('The suggestion came back empty.');
      if (decorative.checked) { decorative.checked = false; description.disabled = false; }
      description.value = suggestion;
      counter.textContent = `${description.value.length} / 2000`;
      suggestStatus.textContent = 'Check the suggestion, then Save.';
    } catch (e) {
      console.warn('[documents] alt-text suggestion failed', e);
      suggestStatus.textContent = 'The suggestion could not be made. Try again in a moment.';
    } finally {
      suggesting = false;
      suggest.disabled = !selected() || !aiAvailable();
    }
  }
  function refresh() {
    const image = selected(), info = current();
    const key = image ? `${image.id}:${image.shell?.length}:${image.alt}` : '';
    if (key === shown) return;
    const switched = (owner?.id ?? null) !== (image?.id ?? null);
    if (switched) save(owner);
    shown = key; owner = image; saved = null;
    const disabled = !image || !info;
    for (const control of [description, title, decorative]) control.disabled = disabled;
    suggest.disabled = disabled || suggesting || !aiAvailable();
    if (!aiAvailable()) suggestStatus.textContent = 'Suggestions need the local AI service. Check that fusion-gateway is running.';
    target.textContent = !image ? 'Select a picture or shape to describe it.' : `${image.name || 'Object'} (${{ picture: 'picture', shape: 'shape', textBox: 'text box', group: 'group', chart: 'chart', diagram: 'diagram' }[kind(image)] || 'object'})`;
    if (switched || document.activeElement !== description) description.value = info?.description ?? image?.alt ?? '';
    if (switched || document.activeElement !== title) title.value = info?.title || '';
    decorative.checked = !!info?.decorative;
    description.disabled = disabled || decorative.checked;
    counter.textContent = `${description.value.length} / 2000`;
  }
  function close() { node.remove(); onClose(); }
  return { node, refresh, show: () => queueMicrotask(() => { refresh(); description.focus(); }), close: () => node.remove() };
}
