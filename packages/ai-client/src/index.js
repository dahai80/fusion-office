import { log, error as logError } from './log.js'

const env = (typeof import.meta !== 'undefined' && import.meta.env) || {}

// Dev servers proxy the gateway under the app origin; the gateway's CORS
// allowlist does not cover arbitrary localhost ports.
const DEV_PROXY = env.DEV ? '/__fusion_gateway' : null

const DEFAULTS = {
    baseUrl: env.VITE_FUSION_GATEWAY_URL || DEV_PROXY || 'http://127.0.0.1:11432',
    apiKey: env.VITE_FUSION_GATEWAY_KEY || '',
    defaultModel: env.VITE_FUSION_MODEL || 'mlx-community/Qwen3.5-9B-4bit',
    timeoutMs: 300000,
}

let config = { ...DEFAULTS }

export function configure(overrides) {
    config = { ...config, ...overrides }
    log('ai', 'configured', config.baseUrl, config.defaultModel || '(no default model)')
}

export function getConfig() {
    return { ...config }
}

export function isConfigured() {
    return !!config.apiKey
}

function headers() {
    const h = { 'Content-Type': 'application/json' }
    if (config.apiKey) h.Authorization = 'Bearer ' + config.apiKey
    return h
}

async function request(path, init, timeoutMs) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs || config.timeoutMs)
    try {
        const res = await fetch(config.baseUrl + path, { ...init, headers: headers(), signal: controller.signal })
        if (!res.ok) {
            const body = await res.text().catch(() => '')
            throw new Error('gateway ' + res.status + ': ' + body.slice(0, 500))
        }
        return res
    } finally {
        clearTimeout(timer)
    }
}

export async function chat(opts) {
    const body = {
        model: opts.model || config.defaultModel,
        messages: opts.messages,
        stream: false,
        temperature: opts.temperature,
        max_tokens: opts.maxTokens,
    }
    const t0 = Date.now()
    const res = await request('/v1/chat/completions', { method: 'POST', body: JSON.stringify(body) }, opts.timeoutMs)
    const data = await res.json()
    const text = data.choices && data.choices[0] && data.choices[0].message ? data.choices[0].message.content : ''
    log('ai', 'chat ok', (Date.now() - t0) + 'ms', text.length + ' chars')
    return text
}

const NEWLINE = String.fromCharCode(10)

export async function chatStream(opts, onDelta) {
    const body = {
        model: opts.model || config.defaultModel,
        messages: opts.messages,
        stream: true,
        temperature: opts.temperature,
        max_tokens: opts.maxTokens,
    }
    const res = await fetch(config.baseUrl + '/v1/chat/completions', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify(body),
    })
    if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error('gateway ' + res.status + ': ' + text.slice(0, 500))
    }
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let full = ''
    while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split(NEWLINE)
        buffer = lines.pop()
        for (const line of lines) {
            const trimmed = line.trim()
            if (!trimmed.startsWith('data:')) continue
            const payload = trimmed.slice(5).trim()
            if (payload === '[DONE]') continue
            let chunk = null
            try {
                chunk = JSON.parse(payload)
            } catch (err) {
                logError('ai', 'bad SSE chunk skipped', payload.slice(0, 120))
                continue
            }
            const delta = chunk.choices && chunk.choices[0] && chunk.choices[0].delta ? chunk.choices[0].delta.content : ''
            if (delta) {
                full += delta
                if (onDelta) onDelta(delta, full)
            }
        }
    }
    log('ai', 'chatStream done', full.length + ' chars')
    return full
}

export async function* chatStreamEvents(opts) {
    const body = {
        model: opts.model || config.defaultModel,
        messages: opts.messages,
        stream: true,
        temperature: opts.temperature,
        max_tokens: opts.maxTokens,
    }
    if (opts.tools && opts.tools.length) {
        body.tools = opts.tools
        body.tool_choice = opts.toolChoice || 'auto'
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs || config.timeoutMs)
    let full = ''
    let toolCount = 0
    try {
        const res = await fetch(config.baseUrl + '/v1/chat/completions', {
            method: 'POST',
            headers: headers(),
            body: JSON.stringify(body),
            signal: controller.signal,
        })
        if (!res.ok) {
            const text = await res.text().catch(() => '')
            throw new Error('gateway ' + res.status + ': ' + text.slice(0, 500))
        }
        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        const calls = new Map()
        let buffer = ''
        while (true) {
            const { done, value } = await reader.read()
            if (done) break
            buffer += decoder.decode(value, { stream: true })
            const lines = buffer.split(NEWLINE)
            buffer = lines.pop()
            for (const line of lines) {
                const trimmed = line.trim()
                if (!trimmed.startsWith('data:')) continue
                const payload = trimmed.slice(5).trim()
                if (payload === '[DONE]') continue
                let chunk = null
                try {
                    chunk = JSON.parse(payload)
                } catch (err) {
                    logError('ai', 'bad SSE chunk skipped', payload.slice(0, 120))
                    continue
                }
                const delta = chunk.choices && chunk.choices[0] && chunk.choices[0].delta
                if (!delta) continue
                if (delta.content) {
                    full += delta.content
                    yield { type: 'text', text: delta.content }
                }
                for (const call of delta.tool_calls || []) {
                    const index = call.index === undefined ? calls.size : call.index
                    const current = calls.get(index) || { id: '', name: '', arguments: '' }
                    if (call.id) current.id = call.id
                    if (call.function && call.function.name) current.name = call.function.name
                    if (call.function && call.function.arguments) current.arguments += call.function.arguments
                    calls.set(index, current)
                }
            }
        }
        for (const call of calls.values()) {
            let input = {}
            if (call.arguments.trim()) {
                try {
                    input = JSON.parse(call.arguments)
                } catch (err) {
                    input = { __unreadable: call.arguments }
                }
            }
            toolCount++
            yield { type: 'tool', id: call.id, name: call.name, input }
        }
        log('ai', 'chatStreamEvents done', full.length + ' chars', toolCount + ' tools')
    } finally {
        clearTimeout(timer)
    }
}

export function extractJson(text) {
    if (!text) return null
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
    const candidate = fenced ? fenced[1] : text
    const start = candidate.search(/[[{]/)
    if (start === -1) return null
    const opener = candidate[start]
    const closer = opener === '{' ? '}' : ']'
    const end = candidate.lastIndexOf(closer)
    if (end <= start) return null
    const slice = candidate.slice(start, end + 1)
    try {
        return JSON.parse(slice)
    } catch (err) {
        logError('ai', 'json extract failed', String(err).slice(0, 120))
        return null
    }
}

export async function jsonChat(opts, retries) {
    const attempts = retries === undefined ? 2 : retries
    let lastRaw = ''
    for (let i = 0; i <= attempts; i++) {
        const raw = await chat({ ...opts, messages: opts.messages })
        lastRaw = raw
        const parsed = extractJson(raw)
        if (parsed !== null) return parsed
        log('ai', 'jsonChat retry', String(i + 1))
    }
    logError('ai', 'jsonChat failed after retries')
    throw new Error('jsonChat: no parseable JSON in model output: ' + lastRaw.slice(0, 200))
}

export async function listModels() {
    const res = await request('/v1/models', { method: 'GET' })
    const data = await res.json()
    const models = (data.data || []).map((m) => ({ id: m.id, loaded: !!m.loaded }))
    log('ai', 'listModels ok', models.length + ' models')
    return models
}

export async function ensureModelLoaded(modelId) {
    const models = await listModels()
    const found = models.find((m) => m.id === modelId)
    if (!found) throw new Error('model not found on gateway: ' + modelId)
    if (found.loaded) return true
    log('ai', 'loading model', modelId)
    await request('/v1/models/' + encodeURIComponent(modelId) + '/load', { method: 'POST' }, 600000)
    return true
}
