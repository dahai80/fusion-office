/**
 * Local task-corpus telemetry for the assistant: every prompt the user sends is recorded in
 * this browser's localStorage, nothing leaves the machine. The corpus shows which kinds of
 * tasks the assistant is actually asked, which is what the eval set (eval/README.md) should
 * cover. Export and clear it from the console:
 *
 *   fusionOffice.promptLog()      // the recorded prompts, oldest first
 *   fusionOffice.exportPromptLog()  // the same, as a JSON file download
 *   fusionOffice.clearPromptLog()   // erase everything recorded
 */

const KEY = 'fusion-office.ai-prompt-log';
const LIMIT = 200;

function read() {
  try {
    const raw = localStorage.getItem(KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch (e) {
    console.warn('Prompt log could not be read:', e?.message || e);
    return [];
  }
}

function write(list) {
  try { localStorage.setItem(KEY, JSON.stringify(list)); } catch (e) {
    // Private browsing or a full quota: the chat keeps working, the corpus just is not kept.
    console.warn('Prompt log could not be written:', e?.message || e);
  }
}

/** Record one prompt the user sent. Attachments are counted, never stored. */
export function recordPrompt({ text = '', attachments = 0, chars = null } = {}) {
  const s = String(text ?? '').trim();
  if (!s) return;
  const list = read();
  list.push({ ts: Date.now(), chars: chars == null ? s.length : chars, files: attachments || 0, text: s });
  if (list.length > LIMIT) list.splice(0, list.length - LIMIT);
  write(list);
}

/** The recorded prompts, oldest first. */
export function readPromptLog() {
  return read();
}

export function clearPromptLog() {
  write([]);
}

/** Download the corpus as JSON (a console helper; needs a user gesture to save). */
export function exportPromptLog() {
  const list = read();
  const blob = new Blob([JSON.stringify({ exported: new Date().toISOString(), count: list.length, prompts: list }, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `fusion-office-prompts-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  console.log(`Exported ${list.length} prompts.`);
}
