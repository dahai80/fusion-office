// A deterministic fusion-gateway stand-in for the AI sidebar: the first request
// answers with one tool call, the request carrying that tool's result answers
// with plain text. No model is loaded and no network leaves the browser.

const frame = (payload) => `data: ${JSON.stringify(payload)}\n\n`;
const DONE = 'data: [DONE]\n\n';
const TOOL_CALL_ID = 'call_gateway_test';

function toolReply(name, args) {
    return (
        frame({
            choices: [
                {
                    delta: {
                        tool_calls: [
                            {
                                index: 0,
                                id: TOOL_CALL_ID,
                                type: 'function',
                                function: { name, arguments: JSON.stringify(args) },
                            },
                        ],
                    },
                },
            ],
        }) + DONE
    );
}

function textReply(text) {
    return frame({ choices: [{ delta: { content: text } }] }) + DONE;
}

export async function mockGateway(page, { tool = '', args = {}, answer = 'Done.' } = {}) {
    const requests = [];
    await page.route('**/__fusion_gateway/v1/chat/completions', async (route) => {
        const body = route.request().postDataJSON();
        requests.push(body);
        const last = body.messages?.[body.messages.length - 1];
        const bodyText =
            tool && last?.role !== 'tool' ? toolReply(tool, args) : textReply(answer);
        await route.fulfill({
            status: 200,
            headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' },
            body: bodyText,
        });
    });
    return requests;
}
