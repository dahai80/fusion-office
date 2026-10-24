import { expect } from '@playwright/test';

const ENDPOINT = '**/__fusion_gateway/v1/chat/completions';

function event(payload) {
    return `data: ${JSON.stringify(payload)}\n\n`;
}

function chunk(delta, finish = null) {
    return event({
        id: 'chatcmpl-test',
        object: 'chat.completion.chunk',
        created: 1700000000,
        model: 'test-model',
        choices: [{ index: 0, delta, finish_reason: finish }],
    });
}

function toolChunk(name, args) {
    return chunk({
        role: 'assistant',
        tool_calls: [{
            index: 0,
            id: 'call_test',
            type: 'function',
            function: { name, arguments: JSON.stringify(args || {}) },
        }],
    });
}

export async function mockGateway(page, turns) {
    let index = 0;
    let current = null;
    const requests = [];
    const errors = [];

    await page.route(ENDPOINT, async (route) => {
        const request = route.request();
        if (request.method() !== 'POST') {
            errors.push(`unexpected ${request.method()} ${request.url()}`);
            await route.fulfill({ status: 405, body: 'method not allowed' });
            return;
        }
        const body = request.postDataJSON();
        const messages = body.messages || [];
        requests.push(body);
        const last = messages[messages.length - 1];
        const response = [];
        if (last?.role === 'tool') {
            response.push(chunk({ role: 'assistant', content: current?.answer || 'Done.' }, 'stop'));
        } else {
            const user = [...messages].reverse().find((message) => message.role === 'user');
            const text = String(user?.content || '');
            const turn = turns[index];
            if (!turn || (turn.prompt && !text.includes(turn.prompt))) {
                errors.push(`unexpected prompt: ${text.slice(-200)}`);
                console.error(`gateway mock: unexpected prompt ${text.slice(-200)}`);
                await route.fulfill({
                    status: 500,
                    contentType: 'application/json',
                    body: JSON.stringify({ error: { message: 'unexpected prompt' } }),
                });
                return;
            }
            index += 1;
            current = turn;
            if (turn.text) response.push(chunk({ role: 'assistant', content: turn.text }, 'stop'));
            else response.push(toolChunk(turn.tool, turn.args), chunk({}, 'tool_calls'));
        }
        response.push('data: [DONE]\n\n');
        await route.fulfill({
            status: 200,
            headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
            body: response.join(''),
        });
    });

    return {
        requests,
        errors,
        consumed: () => index,
        pending: () => turns.length - index,
        expectConsumed() {
            expect(errors, errors.join('\n')).toEqual([]);
            expect(index).toBe(turns.length);
        },
    };
}

export async function openAssistant(page) {
    await page.getByRole('button', { name: 'Project assistant' }).click();
    const dialog = page.getByRole('dialog', { name: 'Project assistant' });
    await expect(dialog).toBeVisible();
    return dialog;
}

export async function askAssistant(page, dialog, prompt, { approve = false } = {}) {
    const input = dialog.locator('.pm-as-input');
    const send = dialog.locator('.pm-as-send');
    await input.fill(prompt);
    await expect(send).toHaveText('Send');
    await send.click();
    if (approve) await dialog.getByRole('button', { name: 'Allow' }).click();
    await expect(send).toHaveText('Send', { timeout: 15000 });
}
