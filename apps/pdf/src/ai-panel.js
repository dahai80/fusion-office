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

// The one-shot summary reads the document itself, so it stays inside hard caps:
// 20 pages per readPages call (the read closure's own cap) and, over the whole
// run, 60 pages and about 40,000 characters of text sent to the model.
const READ_CHUNK_PAGES = 20;
const SUMMARY_PAGE_CAP = 60;
const SUMMARY_CHAR_CAP = 40000;

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
    const docSummaryButton = el('button', { class: 'btn panel-action', type: 'button' }, 'Summarize document');
    const translateLanguage = el('input', {
        class: 'input ai-translate-language',
        type: 'text',
        placeholder: 'Language, e.g. French',
        'aria-label': 'Language to translate the current page into',
    });
    const translateButton = el('button', { class: 'btn panel-action', type: 'button' }, 'Translate page');
    const modelPicker = AI.createModelPicker();
    const root = el(
        'div',
        { class: 'ai-panel' },
        el('p', { class: 'panel-note muted' }, 'The assistant reads the pages and can move to them. Answers come from the local AI service through fusion-gateway.'),
        ...(modelPicker ? [modelPicker] : []),
        question,
        el('div', { class: 'ai-actions' }, askButton, summarizeButton, docSummaryButton, translateLanguage, translateButton),
        status,
        answerBox,
    );
    let busy = false;
    let lastLanguage = '';

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
        docSummaryButton.disabled = on;
        translateButton.disabled = on;
        translateLanguage.disabled = on;
        question.disabled = on;
        root.classList.toggle('busy', on);
    }

    function startOneShot(note) {
        answer.textContent = '';
        steps.replaceChildren();
        answerBox.hidden = false;
        status.textContent = note;
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
        askButton.textContent = 'Stop';
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
            askButton.textContent = 'Ask';
        }
    }

    async function summarizeDocument() {
        if (busy) return;
        if (!isConfigured()) {
            status.textContent = 'AI is not configured. Set VITE_FUSION_GATEWAY_KEY for the gateway.';
            return;
        }
        setBusy(true);
        startOneShot('Reading the document…');
        try {
            const info = commands.info();
            if (!info.pages) {
                status.textContent = 'No PDF is open, or it has no pages to summarize.';
                return;
            }
            const pageCap = Math.min(info.pages, SUMMARY_PAGE_CAP);
            const parts = [];
            let used = 0;
            for (let from = 1; from <= pageCap && used < SUMMARY_CHAR_CAP; from += READ_CHUNK_PAGES) {
                const result = await commands.readPages(from, Math.min(READ_CHUNK_PAGES, pageCap - from + 1));
                if (!result.ok) throw new Error(String(result.content || 'the pages could not be read'));
                const text = String(result.content || '').replace(/\s*\[Read up to page[^\]]*\]\s*$/, '');
                if (!text) continue;
                if (used + text.length > SUMMARY_CHAR_CAP) {
                    parts.push(text.slice(0, Math.max(0, SUMMARY_CHAR_CAP - used)));
                    used = SUMMARY_CHAR_CAP;
                    break;
                }
                parts.push(text);
                used += text.length;
            }
            let documentText = parts.join('\n\n');
            if (documentText.length > SUMMARY_CHAR_CAP) documentText = documentText.slice(0, SUMMARY_CHAR_CAP);
            if (!documentText.trim()) {
                status.textContent = 'No readable text found. The pages may be scanned; run OCR first.';
                return;
            }
            const hitChars = used >= SUMMARY_CHAR_CAP;
            const truncated = hitChars || pageCap < info.pages;
            status.textContent = 'Summarizing…';
            const reply = await AI.chat({
                messages: [
                    {
                        role: 'system',
                        content: 'You summarize PDF documents. Reply in the language of the document text. Start with one short paragraph on what the document is, then "Key points" as short bullets, each with a page reference like [Page 3]. No preamble.',
                    },
                    {
                        role: 'user',
                        content: [
                            `Summarize this document for me. The file is "${name()}".`,
                            truncated
                                ? `Only part of it fits here: ${hitChars ? `the first ${SUMMARY_CHAR_CAP} characters` : `the first ${pageCap} of ${info.pages} pages`} are included. Summarize what is present and say where it stops.`
                                : '',
                            '',
                            'Document text:',
                            documentText,
                        ].filter(Boolean).join('\n'),
                    },
                ],
                maxTokens: 1024,
            });
            const text = String(reply || '').trim();
            if (!text) {
                status.textContent = 'The assistant returned nothing. Try again.';
                return;
            }
            console.log('[pdf] AI summary ok', documentText.length, 'chars in,', text.length, 'chars out');
            answer.textContent = text;
            status.textContent = '';
        } catch (error) {
            console.warn('[pdf] AI summary failed', error);
            status.textContent = aiError(error);
        } finally {
            setBusy(false);
        }
    }

    async function translatePage() {
        if (busy) return;
        if (!isConfigured()) {
            status.textContent = 'AI is not configured. Set VITE_FUSION_GATEWAY_KEY for the gateway.';
            return;
        }
        const target = (translateLanguage.value || lastLanguage || '').trim();
        if (!target) {
            status.textContent = 'Type a language to translate into.';
            translateLanguage.focus();
            return;
        }
        lastLanguage = target;
        setBusy(true);
        startOneShot('Reading the page…');
        try {
            const info = commands.info();
            if (!info.pages) {
                status.textContent = 'No PDF is open, or it has no pages to translate.';
                return;
            }
            const result = await commands.readPages(info.page, 1);
            if (!result.ok) throw new Error(String(result.content || 'the page could not be read'));
            const text = String(result.content || '')
                .replace(/\[Page \d+\]/g, '')
                .replace(/\(no text on this page\)|\(could not be read\)/g, '')
                .trim();
            if (!text) {
                status.textContent = 'This page has no text to translate. It may be scanned; run OCR first.';
                return;
            }
            status.textContent = 'Translating…';
            const reply = await AI.chat({
                messages: [
                    {
                        role: 'system',
                        content: 'You translate the text of a PDF page. Translate it faithfully into the language the person asks for. Keep the meaning, order, names and numbers. Output only the translation, nothing else.',
                    },
                    { role: 'user', content: `Translate the text of page ${info.page} into ${target}.\n\nPage text:\n${text}` },
                ],
                maxTokens: 2048,
            });
            const translated = String(reply || '').trim();
            if (!translated) {
                status.textContent = 'The assistant returned nothing. Try again.';
                return;
            }
            console.log('[pdf] AI page translate ok', 'page', info.page, '->', target);
            answer.textContent = translated;
            status.textContent = '';
        } catch (error) {
            console.warn('[pdf] AI page translate failed', error);
            status.textContent = aiError(error);
        } finally {
            setBusy(false);
        }
    }

    askButton.onclick = () => ask();
    summarizeButton.onclick = () => ask('Summarize this document in a short paragraph, then list its main points.');
    docSummaryButton.onclick = () => summarizeDocument();
    translateButton.onclick = () => translatePage();
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
