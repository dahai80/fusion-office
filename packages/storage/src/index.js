import { log } from './log.js'

export { log } from './log.js'

const IDB_NAME = 'fusion-office-storage'
const IDB_VERSION = 1
const KV_STORE = 'kv'
const INDEX_STORE = 'files'

let rootHandle = null
let backendName = null
let idb = null

export function backend() {
    return backendName
}

async function openIdb() {
    if (idb) return idb
    idb = await new Promise((resolve, reject) => {
        const req = indexedDB.open(IDB_NAME, IDB_VERSION)
        req.onupgradeneeded = () => {
            const db = req.result
            if (!db.objectStoreNames.contains(KV_STORE)) db.createObjectStore(KV_STORE)
            if (!db.objectStoreNames.contains(INDEX_STORE)) db.createObjectStore(INDEX_STORE)
        }
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
    })
    return idb
}

function idbOp(store, mode, fn) {
    return openIdb().then((db) => new Promise((resolve, reject) => {
        const tx = db.transaction(store, mode)
        const req = fn(tx.objectStore(store))
        tx.oncomplete = () => resolve(req && req.result)
        tx.onerror = () => reject(tx.error)
    }))
}

async function opfsRoot() {
    if (rootHandle) return rootHandle
    rootHandle = await navigator.storage.getDirectory()
    backendName = 'opfs'
    log('storage', 'OPFS root acquired')
    return rootHandle
}

async function fsaRoot() {
    if (rootHandle) return rootHandle
    if (typeof showDirectoryPicker !== 'function') {
        throw new Error('fsa-unavailable')
    }
    rootHandle = await showDirectoryPicker({ id: 'fusion-office', mode: 'readwrite', startIn: 'documents' })
    backendName = 'fsa'
    log('storage', 'FSA root acquired')
    return rootHandle
}

async function root() {
    if (rootHandle) return rootHandle
    try {
        return await fsaRoot()
    } catch (err) {
        if (err && err.name === 'AbortError') throw err
        log('storage', 'FSA unavailable, falling back to OPFS', String(err))
        return await opfsRoot()
    }
}

async function dirFor(path, create) {
    const base = await root()
    const parts = String(path).split('/').filter(Boolean)
    const fileName = parts.pop()
    let dir = base
    for (const part of parts) {
        dir = await dir.getDirectoryHandle(part, { create: !!create })
    }
    return { dir, fileName }
}

export async function writeFile(path, data) {
    const { dir, fileName } = await dirFor(path, true)
    const handle = await dir.getFileHandle(fileName, { create: true })
    const writable = await handle.createWritable()
    await writable.write(data)
    await writable.close()
    await idbOp(INDEX_STORE, 'readwrite', (s) => s.put({ path, size: data && data.size, at: Date.now() }, path)).catch(() => {})
    log('storage', 'writeFile ok', path)
}

export async function readFile(path) {
    const { dir, fileName } = await dirFor(path, false)
    const handle = await dir.getFileHandle(fileName)
    const file = await handle.getFile()
    return file
}

export async function readdir(path) {
    const base = await root()
    let dir = base
    const parts = String(path).split('/').filter(Boolean)
    for (const part of parts) {
        dir = await dir.getDirectoryHandle(part)
    }
    const entries = []
    for await (const [name, handle] of dir.entries()) {
        const entry = { name, path: (path ? path.replace(/\/$/, '') + '/' : '') + name, kind: handle.kind }
        if (handle.kind === 'file') {
            try {
                const file = await handle.getFile()
                entry.size = file.size
                entry.mtime = file.lastModified
            } catch (err) {
                log('storage', 'readdir stat failed', entry.path, String(err))
            }
        }
        entries.push(entry)
    }
    return entries
}

export async function deleteFile(path) {
    const { dir, fileName } = await dirFor(path, false)
    await dir.removeEntry(fileName, { recursive: true })
    await idbOp(INDEX_STORE, 'readwrite', (s) => s.delete(path)).catch(() => {})
    log('storage', 'deleteFile ok', path)
}

export async function stat(path) {
    const { dir, fileName } = await dirFor(path, false)
    try {
        const handle = await dir.getFileHandle(fileName)
        const file = await handle.getFile()
        return { kind: 'file', name: fileName, size: file.size, mtime: file.lastModified }
    } catch (err) {
        try {
            await dir.getDirectoryHandle(fileName)
            return { kind: 'directory', name: fileName }
        } catch {
            return null
        }
    }
}

export async function rename(oldPath, newPath) {
    const file = await readFile(oldPath)
    await writeFile(newPath, file)
    await deleteFile(oldPath)
    log('storage', 'rename ok', oldPath, '->', newPath)
}

export async function get(key) {
    return await idbOp(KV_STORE, 'readonly', (s) => s.get(key))
}

export async function set(key, value) {
    return await idbOp(KV_STORE, 'readwrite', (s) => s.put(value, key))
}

export async function del(key) {
    return await idbOp(KV_STORE, 'readwrite', (s) => s.delete(key))
}

export async function pickOpenFile(filters) {
    if (typeof showOpenFilePicker !== 'function') {
        return await legacyPick(filters)
    }
    const [handle] = await showOpenFilePicker({ multiple: false, types: toTypes(filters) })
    return { kind: 'handle', handle, file: await handle.getFile() }
}

export async function pickSaveFile(suggestedName, filters) {
    if (typeof showSaveFilePicker !== 'function') {
        return null
    }
    const handle = await showSaveFilePicker({ suggestedName, types: toTypes(filters) })
    return { kind: 'handle', handle }
}

function toTypes(filters) {
    if (!filters || !filters.length) return undefined
    return filters.map((f) => ({
        description: f.description || f.name || '',
        accept: f.accept || { 'application/octet-stream': f.extensions || [] },
    }))
}

function legacyPick(filters) {
    return new Promise((resolve, reject) => {
        const input = document.createElement('input')
        input.type = 'file'
        if (filters && filters[0] && filters[0].extensions) {
            input.accept = filters[0].extensions.join(',')
        }
        input.onchange = () => {
            if (!input.files || !input.files[0]) return reject(new Error('no-file-selected'))
            resolve({ kind: 'file', file: input.files[0] })
        }
        input.click()
    })
}

export async function downloadFallback(name, blob) {
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = name
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 5000)
    log('storage', 'download fallback used', name)
}
