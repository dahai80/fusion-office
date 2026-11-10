import { describe, expect, it, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Workbook } from '../src/core/workbook.js';
import { createAgent } from '../src/core/aiagent.js';
import { runTool, describeCall } from '../src/core/aitools.js';

// Golden-set replay: real model transcripts recorded from live runs (eval/record.mjs)
// are replayed with the model stubbed, and the final workbook state is asserted. See
// eval/README.md; the design rationale is docs/ask-ai-review.md §4.
const casesDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'eval', 'cases');
const caseFiles = readdirSync(casesDir).filter((f) => f.endsWith('.json'));

function buildAgent(wb, id, replies, requests) {
  let round = -1;
  const chat = (messages, options) => {
    round++;
    requests.push({ messages: messages.map((m) => ({ ...m })), options });
    const parts = replies[round] || [{ type: 'text', text: 'end' }];
    return (async function* stream() { for (const p of parts) yield p; })();
  };
  const env = { sheetId: () => id, selection: () => ({ sheetId: id, range: { r1: 0, c1: 0, r2: 0, c2: 0 } }), distrust: vi.fn() };
  const agent = createAgent({
    chat,
    runTool: (name, args) => runTool(wb, name, args, env),
    describe: (name, args) => describeCall(wb, name, args, env),
    approve: async () => true,
    snapshot: () => 'The user is looking at "Sheet1".',
    settings: () => ({ approval: 'destructive' }),
  });
  return agent;
}

describe.each(caseFiles)('golden case %s', (file) => {
  const c = JSON.parse(readFileSync(join(casesDir, file), 'utf8'));

  it(`replays the recorded run and reaches the expected state (${c.run_meta?.rounds ?? '?'} rounds recorded)`, async () => {
    const wb = new Workbook();
    const id = wb.activeSheetId;
    const env = { sheetId: () => id, selection: () => ({ sheetId: id, range: { r1: 0, c1: 0, r2: 0, c2: 0 } }), distrust: vi.fn() };
    for (const [name, args] of c.fixture || []) runTool(wb, name, args, env);
    const requests = [];
    const agent = buildAgent(wb, id, c.replies, requests);
    const out = await agent.send(c.prompt, () => {});
    expect(out.error).toBeUndefined();
    expect(out.stopped).toBe(false);
    for (const [cell, value] of c.expect || []) {
      const found = wb.rangeFromText(id, cell);
      expect(found, `expect cell ${cell}`).toBeTruthy();
      expect(String(wb.getValue(found.sheetId, found.range.r1, found.range.c1))).toBe(String(value));
    }
  });
});
