import { el } from './lib/ui.js';
import * as AI from '@fusion-office/ai-client';
import { createAgent } from '@fusion-office/ai-client';
import { TOOLS, SYSTEM_PROMPT, changesDocument, describeCall, pdfSnapshot, runTool } from './ai-tools.js';

function aiError(error) {
    const message = String(error?.message || error || '');
    if (/401|unauthori[sz]ed|invalid api key/i.test(message))
        return 'The AI service rejected the request. Check VITE_FUSION_GATEWAY_KEY.';
    if (/402|insufficient|quota|allowance/i.test(message))
        return 'The AI service has no capacity left right now.';
    if (/fetch|network|offline|timed? ?out|abort/i.test(message))
        return 'The AI service could not be reached. Check that fusion-gateway is running.';
    return 'The assistant could not answer. Try again in a moment.';
}

const STATUS_TEXT = { running: 'Working…', done: 'Done', error: 'Failed', declined: 'Skipped', skipped: 'Stopped' };

export function createAiPanel({ commands, name = () => '', isConfigured = () => AI.isConfigured() } = {}) {
    const question = el('textarea', {
        class: 'input ai-question',
        rows: 3,
        placeholder: 'Ask about this PDF, or ask it to find a page',
        'aria-label': 'Question about this document',
    });
    const steps = el('div', { class: 'ai-steps' });
    const answer = el('div', { class: 'ai-answer-text' });
    const answerBox = el('div', { class: 'ai-answer', role: 'region', 'aria-label': 'Answer' }, steps, answer);
    const status = el('p', { class: 'panel-note muted ai-status', role: 'status' });
    const askButton = el('button', { class: 'btn primary panel-action', type: 'button' }, 'Ask');
    const summarizeButton = el('button', { class: 'btn panel-action', type: 'button' }, 'Summarize');
    const modelPicker = AI.createModelPicker();
    const root = el(
        'div',
        { class: 'ai-panel' },
        el('p', { class: 'panel-note muted' }, 'The assistant reads the pages and can move to them. Answers come from the local AI service through fusion-gateway.'),
        ...(modelPicker ? [modelPicker] : []),
        question,
        el('div', { class: 'ai-actions' }, askButton, summarizeButton),
        status,
        answerBox,
    );
    let busy = false;

    const agent = createAgent({
        chat: (messages, options) => AI.chatStreamEvents({ messages, tools: options.tools, model: options.model, maxTokens: options.maxTokens }),
        tools: TOOLS,
        system: SYSTEM_PROMPT,
        snapshot: () => pdfSnapshot(commands, { name: name() }),
        settings: () => ({ approval: 'never' }),
        changes: changesDocument,
        describe: (tool, args) => describeCall(commands, tool, args),
        runTool: (tool, args) => runTool(commands, tool, args),
    });

    function setBusy(on) {
        busy = on;
        summarizeButton.disabled = on;
        question.disabled = on;
        askButton.textContent = on ? 'Stop' : 'Ask';
        root.classList.toggle('busy', on);
    }

    function stepRow(step) {
        const row = el('div', { class: 'ai-step', 'data-step': step.id });
        row.dataset.status = step.status;
        row.append(el('span', { class: 'ai-step-label' }, step.label || step.name), el('span', { class: 'ai-step-status' }, STATUS_TEXT[step.status] || step.status));
        return row;
    }

    async function ask(prompt) {
        if (busy) { agent.stop(); return; }
        const text = String(prompt || question.value || '').trim();
        if (!text) {
            status.textContent = 'Type a question first.';
            question.focus();
            return;
        }
        if (!isConfigured()) {
            status.textContent = 'AI is not configured. Set VITE_FUSION_GATEWAY_KEY for the gateway.';
            return;
        }
        setBusy(true);
        answer.textContent = '';
        steps.replaceChildren();
        answerBox.hidden = false;
        status.textContent = 'Reading…';
        const rows = new Map();
        try {
            const result = await agent.send(text, (event) => {
                if (event.type === 'text') {
                    status.textContent = '';
                    answer.textContent += event.text;
                } else if (event.type === 'step') {
                    status.textContent = '';
                    const step = event.step, known = rows.get(step.id);
                    if (!known) {
                        const row = stepRow(step);
                        rows.set(step.id, row);
                        steps.append(row);
                    } else {
                        known.dataset.status = step.status;
                        known.querySelector('.ai-step-status').textContent = STATUS_TEXT[step.status] || step.status;
                    }
                }
            });
            if (result.error) status.textContent = aiError(result.error);
            else if (!answer.textContent.trim() && !rows.size) status.textContent = 'The assistant returned nothing. Try again.';
            else if (question.value.trim() === text) question.value = '';
        } catch (error) {
            status.textContent = aiError(error);
        } finally {
            setBusy(false);
        }
    }

    askButton.onclick = () => ask();
    summarizeButton.onclick = () => ask('Summarize this document in a short paragraph, then list its main points.');
    question.onkeydown = (event) => {
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            ask();
        }
    };

    return {
        el: root,
        ask,
        reset() {
            // A document reload during a tool call must not wipe the answer still arriving;
            // an edit the assistant asked for reloads the PDF while the turn is running.
            if (agent.running) return;
            agent.stop();
            agent.reset();
            question.value = '';
            answer.textContent = '';
            steps.replaceChildren();
            answerBox.hidden = true;
            status.textContent = '';
        },
    };
}
