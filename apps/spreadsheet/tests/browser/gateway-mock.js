const GATEWAY_PATH = '**/__fusion_gateway/v1/chat/completions';
const STATE_END = '</workbook_state>';

function lastUserText(body) {
    const messages = body.messages || [];
    for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i];
        if (message.role !== 'user') continue;
        let text = typeof message.content === 'string'
            ? message.content
            : Array.isArray(message.content)
                ? (message.content.find((part) => part?.type === 'text')?.text || '')
                : '';
        const end = text.indexOf(STATE_END);
        if (text.startsWith('<workbook_state>') && end >= 0) text = text.slice(end + STATE_END.length);
        return text.trim();
    }
    return '';
}

function envelope(delta) {
    const payload = {
        id: 'mock-completion',
        object: 'chat.completion.chunk',
        created: 0,
        model: 'mock-model',
        choices: [{ index: 0, delta, finish_reason: null }],
    };
    return `data: ${JSON.stringify(payload)}\n\n`;
}

function splitText(text) {
    if (text.length < 2) return [text];
    const middle = Math.ceil(text.length / 2);
    return [text.slice(0, middle), text.slice(middle)];
}

function sseText(text) {
    let body = '';
    for (const piece of splitText(String(text))) body += envelope({ content: piece });
    return `${body}data: [DONE]\n\n`;
}

function sseToolCall(tool, callId) {
    const args = JSON.stringify(tool.arguments || {});
    const middle = Math.max(1, Math.floor(args.length / 2));
    let body = envelope({ role: 'assistant', content: '' });
    body += envelope({ tool_calls: [{ index: 0, id: callId, type: 'function', function: { name: tool.name, arguments: args.slice(0, middle) } }] });
    body += envelope({ tool_calls: [{ index: 0, function: { arguments: args.slice(middle) } }] });
    return `${body}data: [DONE]\n\n`;
}

export async function installGatewayMock(page, script) {
    const cases = Array.isArray(script) ? script : [script];
    const requests = [];
    let pending = null;
    let sequence = 0;

    await page.route(GATEWAY_PATH, async (route) => {
        let body = {};
        try {
            body = route.request().postDataJSON();
        } catch (error) {
            body = {};
        }
        requests.push(body);
        const messages = body.messages || [];
        const last = messages[messages.length - 1];

        if (last?.role === 'tool') {
            const text = pending?.reply || 'Done.';
            pending = null;
            await route.fulfill({ status: 200, contentType: 'text/event-stream', body: sseText(text) });
            return;
        }

        const prompt = lastUserText(body);
        const found = cases.find((item) => prompt.includes(item.prompt));
        if (!found) {
            await route.fulfill({
                status: 500,
                contentType: 'text/plain',
                body: `gateway mock: no case matches prompt ${JSON.stringify(prompt)}`,
            });
            return;
        }
        if (found.tool) {
            pending = found;
            sequence += 1;
            await route.fulfill({ status: 200, contentType: 'text/event-stream', body: sseToolCall(found.tool, `call_mock_${sequence}`) });
            return;
        }
        await route.fulfill({ status: 200, contentType: 'text/event-stream', body: sseText(found.reply || 'Done.') });
    });

    return {
        requests,
        get lastRequest() {
            return requests[requests.length - 1] || null;
        },
    };
}
