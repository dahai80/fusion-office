// The assistant's tool loop, shared by the apps that let the model operate
// their document: the transcript (OpenAI's shape), the snapshot sent with each
// message, the streamed reply and its tool calls, the approval a change waits
// for, and one answer per call so the next request stays well formed. Each app
// brings its own tools, executor, descriptions and snapshot; nothing here
// touches a page.

const OLD_RESULT_CHARS = 1500;
const DEFAULT_BUDGET = 240000;
const DEFAULT_OPEN = '<app_state>';
const DEFAULT_CLOSE = '</app_state>';

const cut = (text, limit) => (text.length > limit ? `${text.slice(0, limit)}…` : text);
const safe = (fn, name, args) => { try { return fn?.(name, args) || {}; } catch { return {}; } };

/** The text a user message is sent as: the snapshot, then what they wrote. */
export function userContent(text, snapshot = '', { open = DEFAULT_OPEN, close = DEFAULT_CLOSE } = {}) {
    if (!snapshot) return String(text ?? '');
    // The snapshot quotes the document, which anyone may have written: text
    // spelling out the closing tag would end the snapshot early.
    const escaped = String(snapshot).replace(/<(\s*\/?\s*app_state)\b/gi, '‹$1');
    return `${open}\n${escaped}\n${close}\n\n${text ?? ''}`;
}

/** What the user wrote, without the snapshot sent with it. */
export function userText(content, { close = DEFAULT_CLOSE } = {}) {
    const text = String(content ?? '');
    const end = text.indexOf(close);
    return text.startsWith('<') && end >= 0 ? text.slice(end + close.length).replace(/^\s+/, '') : text;
}

/**
 * The transcript as sent: the instructions first; earlier turns lose their
 * snapshots and long tool results, and past the budget the oldest turns go.
 * The latest turn always stays whole.
 */
export function requestMessages(messages, { system = '', budget = DEFAULT_BUDGET } = {}) {
    let lastUser = -1;
    for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === 'user') { lastUser = i; break; }
    const out = messages.map((m, i) => {
        if (i >= lastUser) return m;
        if (m.role === 'user') return { ...m, content: userText(m.content) };
        if (m.role === 'tool' && typeof m.content === 'string' && m.content.length > OLD_RESULT_CHARS) {
            return { ...m, content: `${cut(m.content, OLD_RESULT_CHARS)}\n[…cut from an earlier turn; read again if needed]` };
        }
        return m;
    });
    const size = (m) => (typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content ?? '').length) + JSON.stringify(m.tool_calls || '').length;
    let total = out.reduce((n, m) => n + size(m), 0);
    let start = 0;
    while (total > budget) {
        let next = -1;
        for (let i = start + 1; i < out.length; i++) if (out[i].role === 'user') { next = i; break; }
        if (next < 0 || next > lastUser) break;
        for (let i = start; i < next; i++) total -= size(out[i]);
        start = next;
    }
    return [{ role: 'system', content: system }, ...out.slice(start)];
}

/**
 * An assistant for one open document.
 *
 * chat(messages, { model, tools, maxTokens }) is an async iterable of
 * { type: 'text', text } and { type: 'tool', id, name, input }.
 * runTool(name, args, control) → { ok, content, changed, target } or a string
 * (the content), possibly async. describe(name, args) → { label, destructive,
 * detail }. changes(name, args) says whether a call changes the document.
 * approve(step) → Promise<boolean>, asked before a change the approval mode
 * holds back. snapshot() → the state sent with each message.
 *
 * send(text, onEvent) reports { type: 'text' }, { type: 'step' } and
 * { type: 'round' }, and resolves to { stopped, error, steps, empty }.
 */
export function createAgent({ chat, tools = [], runTool, describe = () => ({}), changes = () => false, approve = async () => true, snapshot = () => '', settings = () => ({}), system = '', model = '', maxRounds = 12, maxOutputTokens = 8192 }) {
    const names = new Set(tools.map(tool => tool.function?.name).filter(Boolean));
    let messages = [];
    let running = null;
    let seq = 0;
    const newId = () => `call_${Date.now().toString(36)}_${(++seq).toString(36)}`;

    function needsApproval(name, args, info) {
        if (!changes(name, args)) return false;
        const mode = settings().approval || 'destructive';
        return mode === 'always' || (mode === 'destructive' && !!info.destructive);
    }

    async function exchange(text, onEvent) {
        const transcript = messages;
        const emit = event => { try { onEvent?.(event); } catch { /* reporting must not stop the turn */ } };
        let release;
        const stopped = new Promise(resolve => { release = resolve; });
        const run = { stopped: false, stop() { if (!this.stopped) { this.stopped = true; release(true); } } };
        running = run;
        const steps = [];
        transcript.push({ role: 'user', content: userContent(text, snapshot()) });
        try {
            for (let round = 0; round < maxRounds; round++) {
                if (round) emit({ type: 'round' });
                let said = '';
                const calls = [];
                const stream = chat(requestMessages(transcript, { system }), { model, tools, maxTokens: maxOutputTokens });
                const iter = stream[Symbol.asyncIterator]();
                for (;;) {
                    const next = await Promise.race([iter.next(), stopped]);
                    if (next === true) { Promise.resolve(iter.return?.()).catch(() => {}); break; }
                    if (next.done) break;
                    const part = next.value;
                    if (part?.type === 'text' && part.text) { said += part.text; emit({ type: 'text', text: part.text }); }
                    else if (part?.type === 'tool') calls.push({ id: part.id || newId(), name: String(part.name || ''), input: part.input && typeof part.input === 'object' ? part.input : {} });
                }
                if (run.stopped) {
                    if (said.trim()) transcript.push({ role: 'assistant', content: said });
                    return { stopped: true, steps };
                }
                const empty = !said.trim() && !calls.length;
                if (empty) said = 'I have nothing to add.';
                transcript.push({
                    role: 'assistant', content: said.trim() ? said : null,
                    ...(calls.length ? { tool_calls: calls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.input) } })) } : {}),
                });
                if (!calls.length) {
                    if (empty) emit({ type: 'text', text: said });
                    return { stopped: false, steps, ...(empty ? { empty: true } : {}) };
                }
                for (const call of calls) {
                    const info = safe(describe, call.name, call.input);
                    const step = { id: call.id, name: call.name, args: call.input, status: 'running', ...info };
                    steps.push(step);
                    emit({ type: 'step', step: { ...step } });
                    let content;
                    if (run.stopped) {
                        step.status = 'skipped';
                        content = 'Not run: the user stopped the assistant.';
                    } else if (!names.has(call.name)) {
                        step.status = 'error';
                        content = `Error: there is no tool called ${call.name}.`;
                    } else if (call.input.__unreadable != null) {
                        step.status = 'error';
                        content = 'Error: the arguments could not be read as JSON.';
                    } else if (needsApproval(call.name, call.input, info) && !(await approve(step))) {
                        step.status = 'declined';
                        content = 'The user declined this change. Do not try it another way; say what you would have done.';
                    } else {
                        try {
                            const result = await runTool(call.name, call.input, { stopped: () => run.stopped });
                            const value = result && typeof result === 'object' ? result : { ok: true, content: String(result ?? '') };
                            Object.assign(step, value.ok === false ? { status: 'error' } : { status: 'done' });
                            if (value.changed) step.changed = true;
                            if (value.target !== undefined) step.target = value.target;
                            if (value.error) step.error = value.error;
                            content = value.content ?? (value.ok === false ? 'Error: the tool failed.' : 'Done.');
                        } catch (err) {
                            step.status = 'error';
                            step.error = String(err?.message || err);
                            content = `Error: ${step.error}`;
                        }
                    }
                    emit({ type: 'step', step: { ...step } });
                    transcript.push({ role: 'tool', tool_call_id: call.id, content });
                }
            }
            return { stopped: false, steps, error: `The assistant stopped after ${maxRounds} replies without finishing.` };
        } catch (err) {
            return { stopped: false, steps, error: err?.message || String(err) };
        } finally {
            if (running === run) running = null;
        }
    }

    return {
        get messages() { return messages; },
        get running() { return !!running; },
        send(text, onEvent) {
            if (running) running.stop();
            return exchange(String(text ?? ''), onEvent);
        },
        stop() { running?.stop(); },
        reset() { messages = []; running?.stop(); },
    };
}
