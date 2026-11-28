import { log } from './log.js'

// Issue fusion-office#71 (RFC #64 H1): artifacts-engine is the store of
// record for office files. This module is the remote leg of the storage
// package: every local file is mirrored to the engine through the gateway
// session-authed JSON-RPC proxy (POST /api/v1/artifacts). All remote work
// is fail-soft at the call sites in index.js — when the proxy is absent,
// unreachable, or refuses the caller, local-first behavior is unchanged.

const DEFAULT_RPC_PATH = '/api/v1/artifacts'

let remoteConfig = { rpcPath: DEFAULT_RPC_PATH, headers: {}, enabled: true, fetchImpl: null, kvGet: null, kvSet: null }

export function configureRemote(options = {}) {
    remoteConfig = { ...remoteConfig, ...options }
    log('storage', 'remote configured', 'enabled=' + !!remoteConfig.enabled, remoteConfig.rpcPath)
}

export function remoteEnabled() {
    return !!remoteConfig.enabled && typeof remoteConfig.fetchImpl === 'function'
}

async function rpc(method, params) {
    const fetchImpl = remoteConfig.fetchImpl || fetch
    const res = await fetchImpl(remoteConfig.rpcPath, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...remoteConfig.headers },
        body: JSON.stringify({ jsonrpc: '2.0', id: 'st-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8), method, params }),
    })
    const body = await res.json().catch(() => null)
    if (!res.ok || !body || body.error) {
        const code = body?.error?.code ?? res.status
        const message = body?.error?.message || ('http ' + res.status)
        throw new Error('rpc-' + method + ':' + code + ':' + message)
    }
    return body.result
}

// A stable per-install session id: the engine scopes artifacts to sessions,
// and the browser holds no engine session of its own. One synthetic session
// per browser keeps a user's files together and makes idempotent replays
// (#141) dedupe within it.
async function sessionId() {
    const kvGet = remoteConfig.kvGet, kvSet = remoteConfig.kvSet
    if (typeof kvGet !== 'function' || typeof kvSet !== 'function') throw new Error('remote-kv-unwired')
    let sid = await kvGet('remote-session-id')
    if (!sid) {
        sid = 'office-storage-' + crypto.randomUUID()
        await kvSet('remote-session-id', sid)
    }
    return sid
}

async function toBase64(data) {
    const buf = data instanceof ArrayBuffer ? data : data instanceof Blob ? await data.arrayBuffer() : new TextEncoder().encode(String(data)).buffer
    const bytes = new Uint8Array(buf)
    let bin = ''
    const chunk = 0x8000
    for (let i = 0; i < bytes.length; i += chunk) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk))
    }
    return btoa(bin)
}

function fromBase64ToBlob(b64, mime) {
    const bin = atob(b64)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    return new Blob([bytes], { type: mime || 'application/octet-stream' })
}

async function contentDigest(data) {
    const buf = data instanceof ArrayBuffer ? data : data instanceof Blob ? await data.arrayBuffer() : new TextEncoder().encode(String(data)).buffer
    const digest = await crypto.subtle.digest('SHA-256', buf)
    return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Mirror one local file to the engine. First write creates the artifact
 * (idempotency_key = path + content digest, so offline retries and crash
 * recoveries dedupe per #141); later writes of the same path update the
 * existing artifact as a new version. Returns the artifact id, or null when
 * the remote leg is disabled.
 */
export async function pushFile(path, data, knownArtifactId) {
    if (!remoteEnabled()) return null
    const content = await toBase64(data)
    const digest = await contentDigest(data)
    const mime = data instanceof Blob && data.type ? data.type : 'text/plain'
    const idem = await contentDigest(new TextEncoder().encode(path + '\0' + digest))
    const sid = await sessionId()
    if (knownArtifactId) {
        await rpc('artifact.update', { artifact_id: knownArtifactId, content, change_log: 'office-storage sync ' + new Date().toISOString() })
        log('storage', 'remote update ok', path, knownArtifactId)
        return knownArtifactId
    }
    const result = await rpc('artifact.create', {
        session_id: sid,
        name: path,
        type: 'data',
        content,
        summary: 'office file ' + path,
        change_log: 'office-storage sync',
        metadata: { office_path: path, encoding: 'base64', mime, content_sha256: digest },
        idempotency_key: idem,
    })
    const artifactId = result?.artifact?.id
    log('storage', 'remote push ok', path, artifactId, result?.deduplicated ? 'dedup' : 'new')
    return artifactId || null
}

/**
 * Read one mirrored file back as a Blob. Encoding and mime come from the
 * artifact metadata written at push time.
 */
export async function pullFile(artifactId) {
    const result = await rpc('artifact.get_content', { artifact_id: artifactId })
    const content = typeof result === 'string' ? result : result?.content
    if (typeof content !== 'string') throw new Error('remote-content-missing')
    const meta = result?.artifact?.metadata || result?.metadata || {}
    if (meta.encoding === 'base64') return fromBase64ToBlob(content, meta.mime)
    return new Blob([content], { type: meta.mime || 'text/plain' })
}

export async function deleteRemote(artifactId) {
    await rpc('artifact.delete', { artifact_id: artifactId, soft_delete: true })
    log('storage', 'remote delete ok', artifactId)
}
