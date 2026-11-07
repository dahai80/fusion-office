// The project assistant: a chat in a dialog that runs the agent loop over the
// open project. Every change goes through the store, so the board behind the
// dialog updates as it works; deleting a task asks first.

import { el } from '../lib/dom.js';
import { icon } from './icons.js';
import { openModal } from './modal.js';
import { store } from '../lib/store.js';
import * as AI from '@fusion-office/ai-client';
import { createAgent, parseMarkdownTableParts } from '@fusion-office/ai-client';
import { TOOLS, SYSTEM_PROMPT, changesProject, describeCall, projectSnapshot, runTool } from '../lib/ai-tools.js';

const STATUS_TEXT = { running: 'Working…', done: 'Done', error: 'Failed', declined: 'Skipped', skipped: 'Stopped' };

const SUGGESTIONS = [
    'What is in this project?',
    'Add a task for the next release.',
    'What is due this week?',
    'Break down the top task into steps.',
];

function aiError(error) {
    const message = String(error?.message || error || '');
    if (/401|unauthori[sz]ed|invalid api key/i.test(message)) return 'The AI service rejected the request. Check VITE_FUSION_GATEWAY_KEY.';
    if (/fetch|network|offline|timed? ?out|abort/i.test(message)) return 'The AI service could not be reached. Check that fusion-gateway is running.';
    return 'The assistant could not answer. Try again in a moment.';
}

/** Reads a task list out of a plain reply: a markdown table first (a drawn
 *  header row is dropped), then bullet or numbered lines. Returns rows of
 *  cells, or null when neither. */
function fallbackTaskRows(said) {
    let parts = null;
    try { parts = parseMarkdownTableParts(said); } catch (error) { console.warn('pm assistant: table parse failed', error); }
    if (parts) return parts.hasHeader && parts.rows.length > 1 ? parts.rows.slice(1) : parts.rows;
    const bullets = String(said || '').split(/\r?\n/)
        .map(line => line.trim())
        .filter(line => /^[-*]\s+\S/.test(line) || /^\d+[.)]\s+\S/.test(line))
        .map(line => [line.replace(/^[-*]\s+/, '').replace(/^\d+[.)]\s+/, '')]);
    return bullets.length >= 2 ? bullets : null;
}

export function openProjectAssistant(projectId) {
    const log = el('div', { class: 'pm-as-log', role: 'log', 'aria-label': 'Conversation with the assistant' });
    const status = el('p', { class: 'pm-as-status', role: 'status' });
    const input = el('textarea', { class: 'input pm-as-input', rows: 3, placeholder: 'Ask about this project, or tell the assistant what to change…', 'aria-label': 'Message the assistant' });
    const send = el('button', { class: 'btn btn-primary pm-as-send', type: 'submit' }, 'Send');
    const newChat = el('button', { class: 'btn pm-as-new', type: 'button' }, 'New chat');
    const modelPicker = AI.createModelPicker();
    const form = el('form', { class: 'pm-as-form' }, input, el('div', { class: 'pm-as-bar' }, send, newChat, ...(modelPicker ? [modelPicker] : [])));
    const root = el('div', { class: 'pm-assistant' }, log, status, form);
    const modal = openModal({ title: 'Project assistant', content: root, wide: true });
    let busy = false, turn = null, refuse = null;

    const agent = createAgent({
        chat: (messages, options) => AI.chatStreamEvents({ messages, tools: options.tools, model: options.model, maxTokens: options.maxTokens }),
        tools: TOOLS,
        system: SYSTEM_PROMPT,
        snapshot: () => projectSnapshot(store, projectId),
        settings: () => ({ approval: 'destructive' }),
        changes: changesProject,
        describe: (name, args) => describeCall(store, projectId, name, args),
        runTool: (name, args) => runTool(store, projectId, name, args),
        approve: step => askApproval(step),
    });

    function setBusy(on) {
        busy = on;
        send.textContent = on ? 'Stop' : 'Send';
        send.setAttribute('aria-label', on ? 'Stop' : 'Send');
    }

    function emptyState() {
        if (log.querySelector('.pm-as-message')) return;
        log.replaceChildren(el('p', { class: 'pm-as-empty' }, 'How can I help with this project?'),
            el('div', { class: 'pm-as-suggestions' }, ...SUGGESTIONS.map(text => el('button', { class: 'pm-as-suggestion', type: 'button', onclick: () => submit(text) }, text))));
    }

    function message(who, ...children) {
        log.querySelector('.pm-as-empty')?.remove();
        log.querySelector('.pm-as-suggestions')?.remove();
        const node = el(`div.pm-as-message.is-${who}`, {}, ...children);
        log.append(node);
        node.scrollIntoView?.({ block: 'nearest' });
        return node;
    }

    function stepRow(step) {
        return el('div', { class: 'pm-as-step', 'data-step': step.id },
            el('span', { class: 'pm-as-step-label' }, step.label || step.name),
            el('span', { class: 'pm-as-step-status' }, STATUS_TEXT[step.status] || step.status));
    }

    function askApproval(step) {
        return new Promise(resolve => {
            if (!turn) { resolve(false); return; }
            const card = el('div', { class: 'pm-as-approval' },
                el('p', {}, `${step.label || step.name}. Allow this?`),
                el('div', { class: 'pm-as-actions' },
                    el('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: () => done(true) }, 'Allow'),
                    el('button', { class: 'btn btn-sm', type: 'button', onclick: () => done(false) }, 'Skip')));
            const done = ok => { card.remove(); refuse = null; resolve(ok); };
            refuse = done;
            turn.append(card);
            card.scrollIntoView?.({ block: 'nearest' });
        });
    }

    /** A reply that lists tasks in a table or as bullets but changed nothing
     *  offers to create them. The first cell is the title, the rest the
     *  description; a drawn header row is not a task. Each task is its own
     *  undoable store change. */
    function offerTasks(turnNode, said) {
        const rows = fallbackTaskRows(said);
        if (!rows) return;
        const tasks = rows.map(row => ({
            title: String(row[0] || '').trim().slice(0, 200),
            description: row.slice(1).map(cell => String(cell).trim()).filter(Boolean).join(' — '),
        })).filter(task => task.title);
        if (!tasks.length) return;
        const card = el('div', { class: 'pm-as-approval' },
            el('p', {}, `The reply lists ${tasks.length} task${tasks.length === 1 ? '' : 's'}. Create them?`),
            el('div', { class: 'pm-as-actions' },
                el('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: () => createAll(card) }, 'Create'),
                el('button', { class: 'btn btn-sm', type: 'button', onclick: () => card.remove() }, 'Skip')));
        turnNode.append(card);
        card.scrollIntoView?.({ block: 'nearest' });
        async function createAll(node) {
            let made = 0, failed = 0;
            for (const task of tasks) {
                try {
                    const result = await runTool(store, projectId, 'create_task', { title: task.title, description: task.description });
                    if (result?.ok) made += 1; else failed += 1;
                    if (result && !result.ok) console.warn('pm assistant: create_task rejected', result.content);
                } catch (error) {
                    console.warn('pm assistant: create_task failed', error);
                    failed += 1;
                }
            }
            const summary = failed ? `Created ${made} of ${tasks.length} tasks.` : `Created ${made} task${made === 1 ? '' : 's'}.`;
            node.replaceChildren(el('p', { role: 'status' }, summary));
            status.textContent = summary;
        }
    }

    async function submit(prompt) {
        if (busy) return;
        const text = String(prompt || input.value || '').trim();
        if (!text) { input.focus(); return; }
        if (!AI.isConfigured()) {
            status.textContent = 'AI is not configured. Set VITE_FUSION_GATEWAY_KEY for the gateway.';
            return;
        }
        input.value = '';
        message('me', el('p', {}, text));
        turn = message('assistant', el('div', { class: 'pm-as-answer' }));
        const answer = turn.querySelector('.pm-as-answer');
        let said = '';
        const rows = new Map();
        const changed = [];
        setBusy(true);
        status.textContent = 'Working…';
        try {
            const result = await agent.send(text, event => {
                if (event.type === 'text') {
                    said += event.text;
                    answer.replaceChildren(...said.split(/\n{2,}/).map(part => part.trim()).filter(Boolean).map(part => el('p', {}, part.replace(/\n/g, ' '))));
                    status.textContent = '';
                } else if (event.type === 'step') {
                    const step = event.step, known = rows.get(step.id);
                    if (step.changed) { if (!changed.includes(step)) changed.push(step); }
                    if (!known) { const row = stepRow(step); rows.set(step.id, row); turn.insertBefore(row, answer); }
                    else {
                        known.dataset.status = step.status;
                        known.querySelector('.pm-as-step-status').textContent = STATUS_TEXT[step.status] || step.status;
                    }
                }
            });
            if (result.error) status.textContent = aiError(result.error);
            else if (!said.trim() && !rows.size) status.textContent = 'The assistant returned nothing. Try again.';
            else if (!changed.length) offerTasks(turn, said);
        } catch (error) {
            console.warn('pm assistant: send failed', error);
            status.textContent = aiError(error);
        } finally {
            setBusy(false);
            turn = null;
        }
    }

    send.onclick = event => { event.preventDefault(); if (busy) agent.stop(); else submit(); };
    input.onkeydown = event => {
        if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); submit(); }
    };
    newChat.onclick = () => { agent.reset(); log.replaceChildren(); status.textContent = ''; emptyState(); input.focus(); };
    form.onsubmit = event => { event.preventDefault(); submit(); };
    modal.panel.querySelector('.modal-title')?.insertAdjacentElement('afterend', el('span', { class: 'pm-as-mark', 'aria-hidden': 'true', html: icon('sparkle', 16) }));

    emptyState();
    return { close: () => { refuse?.(false); agent.stop(); modal.close(); } };
}
