import { el } from './lib/ui.js';
import * as AI from '@fusion-office/ai-client';

const SYSTEM_PROMPT = [
    'You answer questions about a PDF document.',
    'The document text is given below, page by page.',
    'Answer only from that text. If the answer is not there, say so plainly.',
    'Be concise. Quote short passages when they help.',
].join(' ');

const MAX_CONTEXT = 14000;

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

export function createAiPanel({ getText, isConfigured = () => AI.isConfigured() } = {}) {
    const question = el('textarea', {
        class: 'input ai-question',
        rows: 3,
        placeholder: 'Ask a question about this PDF',
        'aria-label': 'Question about this document',
    });
    const answer = el('div', { class: 'ai-answer-text' });
    const answerBox = el('div', { class: 'ai-answer', role: 'region', 'aria-label': 'Answer' }, answer);
    const status = el('p', { class: 'panel-note muted ai-status', role: 'status' });
    const askButton = el('button', { class: 'btn primary panel-action', type: 'button' }, 'Ask');
    const summarizeButton = el('button', { class: 'btn panel-action', type: 'button' }, 'Summarize');
    const root = el(
        'div',
        { class: 'ai-panel' },
        el('p', { class: 'panel-note muted' }, 'Answers come from the local AI service through fusion-gateway.'),
        question,
        el('div', { class: 'ai-actions' }, askButton, summarizeButton),
        status,
        answerBox,
    );
    let busy = false;

    function setBusy(on) {
        busy = on;
        askButton.disabled = on;
        summarizeButton.disabled = on;
        question.disabled = on;
        root.classList.toggle('busy', on);
    }

    async function ask(prompt) {
        if (busy) return;
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
        answerBox.hidden = false;
        status.textContent = 'Reading the document…';
        try {
            const context = String((await getText?.()) || '').slice(0, MAX_CONTEXT);
            if (!context) {
                status.textContent = 'This PDF has no text to read. Scanned pages need OCR first.';
                return;
            }
            const messages = [
                { role: 'system', content: SYSTEM_PROMPT },
                { role: 'user', content: `Document text:\n\n${context}\n\nQuestion: ${text}` },
            ];
            status.textContent = 'Thinking…';
            let first = true;
            await AI.chatStream({ messages }, (delta) => {
                if (first) {
                    status.textContent = '';
                    first = false;
                }
                answer.textContent += delta;
            });
            if (first) status.textContent = 'The assistant returned nothing. Try again.';
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
            question.value = '';
            answer.textContent = '';
            answerBox.hidden = true;
            status.textContent = '';
        },
    };
}

