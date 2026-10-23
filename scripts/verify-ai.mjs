import {
    configure,
    isConfigured,
    listModels,
    chat,
    chatStream,
    chatStreamEvents,
    jsonChat,
} from '../packages/ai-client/src/index.js';

const gateway = process.env.FUSION_GATEWAY_URL || 'http://127.0.0.1:11432';
const key = process.env.FUSION_GATEWAY_KEY;
const model = process.env.FUSION_MODEL || 'mlx-community/Qwen3.5-9B-4bit';

const results = [];

function log(message, ...args) {
    console.log('[verify-ai]', message, ...args);
}

const alternateModelId = (id) => id.replaceAll('/', '--');

function preview(text) {
    return String(text || '').replace(/\s+/g, ' ').slice(0, 120);
}

async function step(name, fn) {
    const started = Date.now();
    try {
        const detail = await fn();
        results.push({ name, ok: true, ms: Date.now() - started, detail });
        log(`ok ${name} ${Date.now() - started}ms ${detail || ''}`);
    } catch (error) {
        results.push({ name, ok: false, ms: Date.now() - started, detail: error.message });
        console.error(`[verify-ai] FAIL ${name} ${error.message}`);
    }
}

async function main() {
    if (!key) {
        console.error('[verify-ai] FUSION_GATEWAY_KEY is required');
        process.exit(1);
    }
    configure({ baseUrl: gateway, apiKey: key, defaultModel: model, timeoutMs: 300000 });
    log('gateway', gateway, 'model', model, 'configured', isConfigured());

    await step('models', async () => {
        const models = await listModels();
        const wanted = new Set([model, alternateModelId(model)]);
        const found = models.find((item) => wanted.has(item.id));
        if (!found) throw new Error(`model not registered: ${model}`);
        if (!found.loaded) throw new Error(`model not loaded: ${model}`);
        return `${models.length} models, ${found.id} loaded`;
    });

    await step('chat documents path', async () => {
        const text = await chat({
            messages: [
                { role: 'system', content: 'You are a concise writing assistant.' },
                { role: 'user', content: 'Reply with exactly: OFFICE_OK' },
            ],
            maxTokens: 24,
        });
        if (!text.includes('OFFICE_OK')) throw new Error(`unexpected answer: ${preview(text)}`);
        return preview(text);
    });

    await step('chatStream spreadsheet path', async () => {
        let chunks = 0;
        const text = await chatStream(
            {
                messages: [{ role: 'user', content: 'Name the three primary colors in five words.' }],
                maxTokens: 40,
            },
            () => {
                chunks += 1;
            },
        );
        if (!text.trim()) throw new Error('empty stream');
        return `${chunks} chunks: ${preview(text)}`;
    });

    await step('chatStreamEvents presentation path', async () => {
        let text = '';
        let events = 0;
        for await (const event of chatStreamEvents({
            messages: [{ role: 'user', content: 'Write one short sentence about slides.' }],
            maxTokens: 40,
        })) {
            events += 1;
            if (event.type === 'text') text += event.text;
        }
        if (!text.trim()) throw new Error('no text events');
        return `${events} events: ${preview(text)}`;
    });

    await step('pdf question path', async () => {
        const documentText = '[Page 1] Quarterly revenue grew 12 percent to 4.2 million.';
        const question = 'How much did revenue grow?';
        const text = await chat({
            messages: [
                {
                    role: 'system',
                    content:
                        'You answer questions about a PDF document. Use only the provided text. If the answer is not in the text, say so briefly.',
                },
                {
                    role: 'user',
                    content: `Document text:\n${documentText}\n\nQuestion: ${question}`,
                },
            ],
            maxTokens: 80,
        });
        if (!/12/.test(text)) throw new Error(`answer missed the figure: ${preview(text)}`);
        return preview(text);
    });

    await step('pm checklist path', async () => {
        const parsed = await jsonChat({
            messages: [
                {
                    role: 'system',
                    content: 'You split project tasks into concrete, verifiable steps. Reply with JSON only.',
                },
                {
                    role: 'user',
                    content:
                        'Task: Ship the release\nDescription: Cut 1.0\n' +
                        'Reply as {"items":["..."]} with at most 8 short steps.',
                },
            ],
            maxTokens: 200,
        });
        if (!parsed || !Array.isArray(parsed.items) || parsed.items.length === 0) {
            throw new Error(`no items: ${preview(JSON.stringify(parsed))}`);
        }
        return `${parsed.items.length} items: ${preview(parsed.items.join(' | '))}`;
    });

    const failed = results.filter((item) => !item.ok);
    console.log('[verify-ai] summary', JSON.stringify(results, null, 2));
    if (failed.length) {
        console.error(`[verify-ai] ${failed.length} step(s) failed`);
        process.exit(1);
    }
    log('all live AI checks pass');
}

main().catch((error) => {
    console.error('[verify-ai] crashed', error);
    process.exit(1);
});
