/**
 * Summarize the document with the local AI: the body text (capped) is sent in one request and the
 * answer comes back as plain text, ready for the pane to show and insert at the top of the
 * document as one undo step.
 */
import { textFence, responseText, cleanAnswer } from './ai.js';

export const SUMMARIZE_CHAR_CAP = 20000;

const clean = text => String(text || '').replace(/[￼\u000e]/g, ' ').trim();

/** The request for a concise summary; text past the cap is cut and the cut is said so. */
export function summarizePrompt(text, cap = SUMMARIZE_CHAR_CAP) {
  const body = clean(text);
  const truncated = body.length > cap;
  const kept = truncated ? body.slice(0, cap) : body;
  const fence = textFence(kept);
  return `You are a careful summarizer inside a word processor. Summarize the document between the ${fence} lines in a few sentences (or a short bulleted list when it has several distinct points), in the document's own language. Keep the facts; add nothing.${truncated ? ` The document is longer than ${cap} characters, so only its first ${cap} characters are included.\n` : ''}Reply with the summary text only: no preamble, no quotation marks around it, no explanations.\n\nDocument:\n${fence}\n${kept}\n${fence}`;
}

/** Ask the model with `chat(prompt)`; resolves the cleaned summary or throws a readable error. */
export async function summarizeDocument(text, { chat } = {}) {
  if (!clean(text)) throw new Error('The document has no text to summarize.');
  let answer;
  try { answer = await chat(summarizePrompt(text)); }
  catch (e) { throw new Error('The summary could not be made. Try again in a moment.', { cause: e }); }
  const summary = cleanAnswer(responseText(answer));
  if (!summary) throw new Error('The AI service returned nothing to use.');
  return summary;
}
