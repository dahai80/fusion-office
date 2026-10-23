import * as S from '@fusion-office/storage';
import { log } from '@fusion-office/storage';
import { safeName } from '../core/document.js';

export const FOLDER = 'PDF Editor';

const LOCAL_USER = Object.freeze({ username: 'local', email: '', full_name: 'Local user' });

export const isApp = () => true;
export const sessionToken = () => null;

export async function currentUser() {
    return LOCAL_USER;
}

export async function isSignedIn() {
    return true;
}

export const isSignInCancelled = () => false;

export async function signIn() {
    return LOCAL_USER;
}

export function onAuth(handler) {
    try {
        handler?.(LOCAL_USER);
    } catch (err) {
        log('pdf', 'auth handler failed', String(err));
    }
}

export async function signOut() {
    log('pdf', 'signOut ignored: local edition has no account session');
}

export async function listFiles() {
    let items;
    try {
        items = await S.readdir(FOLDER);
    } catch (err) {
        if (isNotFound(err)) return [];
        log('pdf', 'listFiles failed', String(err));
        throw err;
    }
    return items
        .filter((f) => f.kind !== 'directory' && /\.pdf$/i.test(f.name))
        .map((f) => ({
            name: f.name,
            path: f.path || `${FOLDER}/${f.name}`,
            size: f.size ?? 0,
            modified: f.mtime ?? 0,
            uid: f.path,
            isDir: false,
        }));
}

export async function readFile(path, { maxBytes = Infinity, signal } = {}) {
    signal?.throwIfAborted();
    const file = await S.readFile(path);
    signal?.throwIfAborted();
    if (file.size > maxBytes) throw new Error(`Choose a PDF smaller than ${maxBytes / (1024 * 1024)} MB.`);
    const bytes = await file.arrayBuffer();
    signal?.throwIfAborted();
    return new Uint8Array(bytes);
}

export async function saveFile(name, bytes, path = null) {
    const target = path || `${FOLDER}/${safeName(name)}`;
    if (!path && await statFile(target)) {
        const stem = safeName(name).replace(/\.pdf$/i, '');
        let n = 2;
        while (await statFile(`${FOLDER}/${stem} ${n}.pdf`)) n += 1;
        return saveFile(`${stem} ${n}.pdf`, bytes, null);
    }
    await S.writeFile(target, new Blob([bytes], { type: 'application/pdf' }));
    const item = await S.stat(target);
    log('pdf', 'saved', target);
    return {
        name: target.split('/').pop(),
        path: target,
        size: item?.size ?? bytes.length,
        modified: item?.mtime ?? Date.now(),
        uid: target,
    };
}

export async function pickFile() {
    let picked;
    try {
        picked = await S.pickOpenFile([{ description: 'PDF', extensions: ['.pdf'] }]);
    } catch (err) {
        if (!/abort|cancel/i.test(String(err?.name || err?.message))) log('pdf', 'pickFile failed', String(err));
        return null;
    }
    const file = picked?.file || (picked?.handle ? await picked.handle.getFile() : null);
    if (!file) return null;
    const name = safeName(file.name) || 'Document.pdf';
    let path = `${FOLDER}/${name}`;
    if (await statFile(path)) {
        const stem = name.replace(/\.pdf$/i, '');
        let n = 2;
        while (await statFile(`${FOLDER}/${stem} ${n}.pdf`)) n += 1;
        path = `${FOLDER}/${stem} ${n}.pdf`;
    }
    await S.writeFile(path, file);
    log('pdf', 'imported', path);
    return { name: path.split('/').pop(), path, size: file.size, modified: Date.now(), uid: path };
}

export async function saveAs(name, bytes) {
    const blob = new Blob([bytes], { type: 'application/pdf' });
    if (typeof showSaveFilePicker !== 'function') {
        await S.downloadFallback(safeName(name), blob);
        return { name: safeName(name), path: safeName(name) };
    }
    try {
        const picked = await S.pickSaveFile(safeName(name), [{ description: 'PDF', extensions: ['.pdf'] }]);
        if (!picked?.handle) return null;
        const writable = await picked.handle.createWritable();
        await writable.write(blob);
        await writable.close();
        const saved = picked.handle.name || safeName(name);
        log('pdf', 'saved a copy', saved);
        return { name: saved, path: saved };
    } catch (err) {
        if (/abort|cancel/i.test(String(err?.name || err?.message))) return null;
        log('pdf', 'saveAs failed', String(err));
        throw err;
    }
}

export async function deleteFile(path) {
    await S.deleteFile(path);
}

export async function renameFile(path, name) {
    const target = `${path.slice(0, path.lastIndexOf('/'))}/${safeName(name)}`;
    await S.rename(path, target);
    return statFile(target);
}

export function isNotFound(error) {
    const code = error?.code || error?.error?.code || '';
    if (code === 'subject_does_not_exist' || code === 'ENOENT' || code === 'NotFoundError') return true;
    const message = String(error?.message || error?.error?.message || error || '').toLowerCase();
    return /not found|does not exist|no such/.test(message);
}

export const isDirItem = (item) => !!(item?.is_dir || item?.isDir || item?.isDirectory || item?.kind === 'directory');

export const inTrash = (path) => typeof path === 'string' && /^(?:\/[^/]+|~)\/Trash(?:\/|$)/.test(path);

export function fileInfo(item) {
    if (!item?.path) return null;
    const modified = Number(item.modified ?? item.mtime);
    return {
        path: item.path,
        name: item.name || item.path.split('/').pop(),
        uid: item.uid || item.id || item.path,
        size: Number(item.size) || 0,
        modified: modified > 0 ? (modified < 1e12 ? modified * 1000 : modified) : 0,
        dir: isDirItem(item),
    };
}

export const canStat = () => true;

export async function statFile(target) {
    const path = typeof target === 'string' ? target : target?.path;
    if (!path) return null;
    try {
        const item = await S.stat(path);
        if (!item) return null;
        return fileInfo({
            path,
            name: item.name,
            size: item.size,
            modified: item.mtime,
            kind: item.kind,
            uid: path,
        });
    } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
    }
}

export async function readBlob(path, { maxBytes = Infinity, signal } = {}) {
    signal?.throwIfAborted();
    const file = await S.readFile(path);
    signal?.throwIfAborted();
    if (file.size > maxBytes) throw new Error(`Choose a file smaller than ${maxBytes / (1024 * 1024)} MB.`);
    return file;
}

let windowTitle = null;
export function setWindowTitle(title) {
    if (title === windowTitle) return;
    try {
        document.title = String(title || 'PDF');
        windowTitle = title;
    } catch {
        log('pdf', 'setWindowTitle skipped: no document');
    }
}

export function onWindowClose() {
    return false;
}

export function exitApp() {
    log('pdf', 'exitApp ignored: local edition is a web page');
}
