import { configure, chatStreamEvents } from '/Users/dahai/fusion/fusion-office/packages/ai-client/src/index.js'
import { createAgent } from '/Users/dahai/fusion/fusion-office/apps/spreadsheet/src/core/aiagent.js'
import { createPlanner } from '/Users/dahai/fusion/fusion-office/apps/spreadsheet/src/core/aiplan.js'
import { runTool, changesWorkbook, describeCall } from '/Users/dahai/fusion/fusion-office/apps/spreadsheet/src/core/aitools.js'
import { Workbook } from '/Users/dahai/fusion/fusion-office/apps/spreadsheet/src/core/workbook.js'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// Live pass@k over the golden cases: re-runs each case N times against the
// gateway and reports how often the expected final state was reached. Real
// model calls; manual, never CI. Usage:
//   node eval/run-live.mjs [runs=3] [baseUrl] [apiKey] [model] [--planner]
// --planner runs the same cases through the plan-then-apply core (aiplan.js)
// so both architectures can be compared on the same model.
const here = dirname(fileURLToPath(import.meta.url))
const flagPlanner = process.argv.includes('--planner')
const args = process.argv.slice(2).filter((a) => a !== '--planner')
const runs = Number(args[0] || 3)
const baseUrl = args[1] || 'http://127.0.0.1:11432'
const apiKey = args[2] || ''
const model = args[3] || ''
configure({ baseUrl, apiKey, defaultModel: model || undefined })

const cases = readdirSync(join(here, 'cases')).filter((f) => f.endsWith('.json'))
console.log(`eval: ${cases.length} cases x ${runs} runs, base=${baseUrl} model=${model || '(picker chain)'} core=${flagPlanner ? 'planner' : 'agent'}`)

function buildFixture(wb, env, fixture) {
    for (const [name, args] of fixture || []) runTool(wb, name, args, env)
}

function checkExpect(wb, sid, expect) {
    for (const [cell, value] of expect || []) {
        const found = wb.rangeFromText(sid, cell)
        if (!found) return `expect cell ${cell} unparseable`
        const got = wb.getValue(found.sheetId, found.range.r1, found.range.c1)
        if (String(got) !== String(value)) return `${cell}: expected ${JSON.stringify(value)}, got ${JSON.stringify(got)}`
    }
    return null
}

function makeCore(wb, env) {
    if (flagPlanner) {
        return createPlanner({
            wb,
            chat: (messages, opts) => chatStreamEvents({ messages, tools: opts.tools, maxTokens: Math.min(opts.maxTokens, 8192) }),
            runTool: async (name, args) => runTool(wb, name, args, env),
            describe: (name, args) => { try { return describeCall(wb, name, args, env) } catch { return { label: name } } },
            approve: async () => true,
            snapshot: () => 'The user is looking at "Sheet1".',
            env,
        })
    }
    return createAgent({
        chat: (messages, opts) => chatStreamEvents({ messages, tools: opts.tools, maxTokens: Math.min(opts.maxTokens, 8192) }),
        runTool: async (name, args) => runTool(wb, name, args, env),
        describe: (name, args) => ({ label: name, destructive: changesWorkbook(name), detail: '' }),
        approve: async () => true,
        snapshot: () => 'The user is looking at "Sheet1".',
    })
}

for (const file of cases) {
    const c = JSON.parse(readFileSync(join(here, 'cases', file), 'utf8'))
    let passed = 0
    const failures = []
    for (let i = 0; i < runs; i++) {
        const wb = new Workbook()
        const sid = wb.activeSheetId
        const env = { sheetId: () => sid, selection: () => ({ sheetId: sid, range: { r1: 0, c1: 0, r2: 0, c2: 0 } }), distrust: () => {} }
        buildFixture(wb, env, c.fixture)
        const core = makeCore(wb, env)
        const result = await core.send(c.prompt, () => {})
        const why = result.error ? `error: ${String(result.error).slice(0, 120)}` : checkExpect(wb, sid, c.expect)
        if (why) failures.push(`run${i + 1}: ${why}`)
        else passed++
    }
    console.log(`${c.name}: ${passed}/${runs} passed${failures.length ? '\n  ' + failures.join('\n  ') : ''}`)
}
