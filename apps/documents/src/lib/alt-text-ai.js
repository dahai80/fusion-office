/**
 * Alt-text suggestions through the local AI: the picture's name and size plus the text before and
 * after it are sent in one request, and the answer is a one- or two-sentence description the user
 * still saves themselves.
 */
import { textFence, responseText } from './ai.js';

const CONTEXT_CAP = 400;

const near = text => String(text || '').replace(/[￼\u000e]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, CONTEXT_CAP);

/** The request for one alt-text suggestion from the image's context. */
export function altTextPrompt({ name, width, height, before = '', after = '' } = {}) {
  const lead = near(before), tail = near(after);
  const facts = [
    name ? `file name "${String(name).slice(0, 120)}"` : '',
    width > 0 && height > 0 ? `about ${Math.round(width)} x ${Math.round(height)} px` : '',
  ].filter(Boolean).join(', ');
  const wrap = t => { const f = textFence(t); return `${f}\n${t}\n${f}`; };
  return [
    'You write alt text inside a word processor. Describe the selected picture or shape for a reader who cannot see it: one or two plain sentences, in the language of the surrounding text. Use the context below as hints; do not invent details it does not support.',
    facts ? `Known facts: ${facts}.` : '',
    lead ? `Paragraph before the object:\n${wrap(lead)}` : '',
    tail ? `Paragraph after the object:\n${wrap(tail)}` : '',
    'Reply with the alt text only: no quotation marks around it, no explanation.',
  ].filter(Boolean).join('\n\n');
}

/** The suggestion in an answer: plain single-line text that fits the description field. */
export function cleanSuggestion(answer) {
  return responseText(answer).replace(/\s+/g, ' ').trim().slice(0, 2000);
}
