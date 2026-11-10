import { configure, chatStreamEvents } from '/Users/dahai/fusion/fusion-office/packages/ai-client/src/index.js'
import { createAgent } from '/Users/dahai/fusion/fusion-office/apps/spreadsheet/src/core/aiagent.js'
import { runTool, changesWorkbook } from '/Users/dahai/fusion/fusion-office/apps/spreadsheet/src/core/aitools.js'
import { Workbook } from '/Users/dahai/fusion/fusion-office/apps/spreadsheet/src/core/workbook.js'
import { writeFileSync, readFileSync } from 'node:fs'

// Records a live agent run into an eval case: the prompt, the workbook fixture
// the run started from, the model's replies per round (replayable in tests),
// and nothing else. Usage: node eval/record.mjs <case.json> where the input
// file is { name, prompt, fixture: [[tool, args], ...] }.
configure({ baseUrl: 'http://127.0.0.1:11499', apiKey: 'x', defaultModel: 'glm-5' })

const inPath = process.argv[2]
const input = JSON.parse(readFileSync(inPath, 'utf8'))
const wb = new Workbook()
const sid = wb.activeSheetId
const env = { sheetId: () => sid, selection: () => ({ sheetId: sid, range: { r1: 0, c1: 0, r2: 0, c2: 0 } }), distrust: () => {} }
for (const [name, args] of input.fixture || []) runTool(wb, name, args, env)

let round = -1
const replies = []
const chat = (messages, opts) => {
    round++
    replies[round] = []
    return recordStream({ messages, tools: opts.tools, maxTokens: Math.min(opts.maxTokens, 8192) }, replies[round])
}
async function* recordStream(req, sink) {
    for await (const part of chatStreamEvents(req)) {
        if (part.type === 'tool') sink.push({ type: 'tool', id: part.id, name: part.name, input: part.input })
        else if (part.type === 'text') sink.push({ type: 'text', text: part.text })
        else if (part.type === 'cut') sink.push({ type: 'cut' })
        yield part
    }
}
const agent = createAgent({
    chat,
    runTool: async (name, args) => runTool(wb, name, args, env),
    describe: (name, args) => ({ label: name, destructive: changesWorkbook(name), detail: JSON.stringify(args).slice(0, 120) }),
    approve: async () => true,
    snapshot: () => 'The user is looking at "Sheet1".',
})
const result = await agent.send(input.prompt, () => {})
const out = {
    name: input.name,
    prompt: input.prompt,
    fixture: input.fixture || [],
    replies,
    expect: input.expect || [],
    run_meta: { rounds: replies.length, stopped: !!result.stopped, error: result.error ? String(result.error).slice(0, 200) : null },
}
writeFileSync(inPath.replace(/\.json$/, '.case.json'), JSON.stringify(out, null, 2))
console.log('recorded', out.name, 'rounds=' + replies.length, result.error ? 'error=' + String(result.error).slice(0, 100) : 'ok')
