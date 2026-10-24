// A deterministic fusion-gateway stand-in for the assistant: each user
// message is answered by the next queued exchange, made of one or more tool
// calls followed by a closing line. No model is loaded and no request leaves
// the browser.

const frame = (payload) => `data: ${JSON.stringify(payload)}\n\n`;
const DONE = "data: [DONE]\n\n";

/**
 * Installs the gateway route and returns a queue the test fills before each
 * message:
 *   gateway.reply([{ name: "read_slide", args: { slide: 1 } }], "Read it.");
 * The request carrying that tool's result is answered with `answer`.
 */
export function installGatewayMock(page) {
  const requests = [];
  const exchanges = [];
  let current = null;
  let callSeq = 0;

  const toolReply = (calls) =>
    frame({
      choices: [
        {
          delta: {
            tool_calls: calls.map((call, index) => ({
              index,
              id: call.id,
              type: "function",
              function: {
                name: call.name,
                arguments: JSON.stringify(call.args ?? {}),
              },
            })),
          },
        },
      ],
    }) + DONE;

  const textReply = (text) =>
    frame({ choices: [{ delta: { content: text } }] }) + DONE;

  async function handler(route) {
    const body = route.request().postDataJSON();
    requests.push(body);
    const last = body.messages?.[body.messages.length - 1];
    let payload;
    if (last?.role === "tool") {
      payload = textReply(current?.answer ?? "Done.");
    } else {
      current = exchanges.shift() || { calls: [], answer: "Done." };
      payload = current.calls.length
        ? toolReply(current.calls)
        : textReply(current.answer);
    }
    await route.fulfill({
      status: 200,
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
      },
      body: payload,
    });
  }

  return {
    requests,
    async install() {
      await page.route("**/__fusion_gateway/v1/chat/completions", handler);
    },
    reply(toolCalls, answer = "Done.") {
      exchanges.push({
        calls: toolCalls.map((call) => ({
          ...call,
          id: call.id || `call_gateway_${++callSeq}`,
        })),
        answer,
      });
    },
  };
}
