/**
 * AI thesaurus lookups: one request asks the local AI for the senses of a word (part of speech,
 * meaning, synonyms, antonyms) in the same shape the bundled WordNet pane renders. Callers pass a
 * `chat` only when the AI is available and fall back to the local data otherwise or on failure.
 */
import { responseText } from './ai.js';

/** The question for one word, asking for a JSON answer the pane can lay out. */
export function thesaurusPrompt(word) {
  return [
    'You are a thesaurus. For the word or phrase between the markers, list its common senses.',
    'Reply with JSON only, no prose and no code fences, in exactly this shape:',
    '{"senses":[{"pos":"noun|verb|adjective|adverb|other","meaning":"a few words","synonyms":["..."],"antonyms":["..."]}]}',
    'Give at most 6 senses, at most 10 synonyms and 4 antonyms each, most common first, in the language of the word. Use an empty list when there are none.',
    `<<<\n${String(word).slice(0, 200)}\n>>>`,
  ].join('\n');
}

const cleanList = (list, max) => Array.isArray(list) ? [...new Set(list.filter(w => typeof w === 'string').map(w => w.trim()).filter(w => w && w.length <= 60))].slice(0, max) : [];

/** The senses in an answer (JSON, perhaps wrapped in prose or a code fence); [] when it holds none. */
export function parseAiSenses(reply) {
  const text = String(reply ?? '');
  const start = text.indexOf('{'), end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return [];
  let parsed;
  try { parsed = JSON.parse(text.slice(start, end + 1)); } catch { return []; }
  const senses = Array.isArray(parsed?.senses) ? parsed.senses : Array.isArray(parsed) ? parsed : [];
  return senses.slice(0, 8).map(s => ({
    pos: typeof s?.pos === 'string' ? s.pos.trim().toLowerCase().slice(0, 20) : '',
    gloss: typeof s?.meaning === 'string' ? s.meaning.trim().slice(0, 200) : '',
    synonyms: cleanList(s?.synonyms, 10),
    antonyms: cleanList(s?.antonyms, 6),
  })).filter(s => s.synonyms.length || s.antonyms.length);
}

/**
 * Look a word up: the AI when `chat` is given and answers, otherwise `offline` (the bundled
 * WordNet data). Both resolve { senses, lemma } in the pane's shape.
 */
export async function lookupSenses(word, { chat, offline } = {}) {
  if (chat) {
    try {
      const senses = parseAiSenses(responseText(await chat(thesaurusPrompt(word))));
      if (senses.length) return { senses, lemma: null };
    } catch (e) { console.warn('[documents] AI thesaurus failed, using the local data', e); }
  }
  return offline(word);
}
