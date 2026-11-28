import { describe, expect, test, beforeEach } from 'vitest'
import { configureRemote, deleteRemote, pullFile, pushFile, remoteEnabled } from '../src/remote.js'

const kv = new Map()
const calls = []

function mockFetch(handler) {
    return async (url, init) => {
        const body = JSON.parse(init.body)
        calls.push({ url, method: body.method, params: body.params })
        const out = handler(body.method, body.params)
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: out }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
}

const engine = {
    nextId: 1,
    artifacts: new Map(),
    fetch() {
        return mockFetch((method, params) => {
            if (method === 'artifact.create') {
                const replay = [...this.artifacts.values()].find((a) => a.metadata._idempotency_key === params.idempotency_key)
                if (replay) return { artifact: replay, deduplicated: true }
                const art = { id: 'art-' + this.nextId++, name: params.name, content: params.content, metadata: { ...params.metadata, _idempotency_key: params.idempotency_key || undefined } }
                this.artifacts.set(art.id, art)
                return { artifact: art, version: { size_bytes: params.content.length }, ref_text: 'ref' }
            }
            if (method === 'artifact.update') {
                const art = this.artifacts.get(params.artifact_id)
                if (!art) throw new Error('not-found')
                art.content = params.content
                return { artifact: art }
            }
            if (method === 'artifact.get_content') {
                const art = this.artifacts.get(params.artifact_id)
                if (!art) throw new Error('not-found')
                return { content: art.content, artifact: { id: art.id, metadata: art.metadata } }
            }
            if (method === 'artifact.delete') {
                this.artifacts.delete(params.artifact_id)
                return { ok: true }
            }
            throw new Error('no such method ' + method)
        })
    },
}

beforeEach(() => {
    kv.clear()
    calls.length = 0
    engine.nextId = 1
    engine.artifacts.clear()
    configureRemote({ enabled: true, fetchImpl: engine.fetch(), kvGet: (k) => kv.get(k), kvSet: (k, v) => kv.set(k, v) })
})

describe('storage remote leg (#71)', () => {
    test('pushFile creates artifact with idempotency key and session id', async () => {
        const id = await pushFile('docs/a.txt', 'hello fusion')
        expect(id).toBe('art-1')
        expect(calls[0].method).toBe('artifact.create')
        expect(calls[0].params.session_id).toMatch(/^office-storage-/)
        expect(calls[0].params.idempotency_key).toBeTypeOf('string')
        expect(calls[0].params.type).toBe('data')
        expect(calls[0].params.metadata.encoding).toBe('base64')
        expect(calls[0].params.metadata.office_path).toBe('docs/a.txt')
    })

    test('pushFile replays dedupe per #141: same path+content returns same artifact', async () => {
        const a = await pushFile('docs/a.txt', 'same')
        const b = await pushFile('docs/a.txt', 'same')
        expect(a).toBe(b)
        const creates = calls.filter((c) => c.method === 'artifact.create')
        expect(creates.length).toBe(2)
        expect(engine.artifacts.size).toBe(1)
    })

    test('changed content of same path creates a new artifact (caller passes knownArtifactId to update)', async () => {
        const a = await pushFile('docs/a.txt', 'v1')
        const b = await pushFile('docs/a.txt', 'v2')
        expect(a).not.toBe(b)
        const upd = await pushFile('docs/a.txt', 'v3', a)
        expect(upd).toBe(a)
        expect(calls.at(-1).method).toBe('artifact.update')
        const round = await pullFile(a)
        expect(round.size).toBe(2)
    })

    test('pullFile round-trips binary content through base64', async () => {
        const blob = new Blob([new Uint8Array([0, 1, 2, 250, 251])], { type: 'application/vnd.test' })
        const id = await pushFile('sheets/b.xlsx', blob)
        const back = await pullFile(id)
        expect(back.type).toBe('application/vnd.test')
        const bytes = new Uint8Array(await back.arrayBuffer())
        expect(Array.from(bytes)).toEqual([0, 1, 2, 250, 251])
    })

    test('deleteRemote removes the artifact', async () => {
        const id = await pushFile('docs/c.txt', 'bye')
        await deleteRemote(id)
        expect(engine.artifacts.has(id)).toBe(false)
    })

    test('disabled remote is inert; upstream failure surfaces as thrown rpc error', async () => {
        configureRemote({ enabled: false, fetchImpl: engine.fetch(), kvGet: (k) => kv.get(k), kvSet: (k, v) => kv.set(k, v) })
        expect(remoteEnabled()).toBe(false)
        expect(await pushFile('docs/d.txt', 'x')).toBe(null)
        configureRemote({ enabled: true, fetchImpl: async () => new Response('{"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"upstream down"}}', { status: 503 }), kvGet: (k) => kv.get(k), kvSet: (k, v) => kv.set(k, v) })
        await expect(pushFile('docs/d.txt', 'x')).rejects.toThrow('rpc-artifact.create')
    })
})
