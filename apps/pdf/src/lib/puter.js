/**
 * Everything the app asks of its environment, in one place: the workspace's local
 * storage (File System Access API with an OPFS fallback), or an SDK placed on the page
 * by the shell or the browser tests. The name and shape follow the Puter edition so
 * the rest of the code needs no changes at every call site.
 *
 *  auth      a single local user; a page SDK may offer a real sign-in instead
 *  env       'app' only inside a desktop window
 *  files     PDFs under /PDF Editor, local by default
 *  pickers   the browser's open/save dialogs, imported into /PDF Editor
 */

import * as S from '@fusion-office/storage';
import { log } from '@fusion-office/storage';
import { safeName } from '../core/document.js';

export const FOLDER = 'PDF Editor';

const LOCAL_USER = Object.freeze({ username: 'Local workspace', email: '', full_name: 'Local workspace' });

const pageSdk = () => globalThis.puter || null;
const fsSdk = () => globalThis.puter?.fs || null;
const authSdk = () => globalThis.puter?.auth || null;
const uiSdk = () => globalThis.puter?.ui || null;

export const isApp = () => globalThis.puter?.env === 'app';

export const sessionToken = () => globalThis.puter?.authToken ?? null;

export async function currentUser() {
    const auth = authSdk();
    if (!auth) return LOCAL_USER;
    try {
        return isApp() || (await auth.isSignedIn()) ? await auth.getUser() : null;
    } catch (err) {
        log('pdf', 'currentUser failed', String(err));
        return null;
    }
}

export async function isSignedIn() {
    const auth = authSdk();
    if (!auth) return true;
    try {
        return isApp() || !!(await auth.isSignedIn());
    } catch (err) {
        log('pdf', 'isSignedIn failed', String(err));
        return false;
    }
}

export const isSignInCancelled = (error) => error?.code === 'sign-in-cancelled';

export async function signIn() {
    const auth = authSdk();
    if (!auth) return LOCAL_USER;
    try {
        await auth.signIn();
    } catch (error) {
        if (error instanceof Error) throw error;
        const normalized = new Error(
            error?.error === 'auth_window_closed'
                ? 'The sign-in was cancelled.'
                : error?.msg || error?.message || 'The workspace could not sign you in. Please try again.',
        );
        if (error?.error === 'auth_window_closed') normalized.code = 'sign-in-cancelled';
        throw normalized;
    }
    return auth.getUser();
}

export function onAuth(handler) {
    const sdk = pageSdk();
    if (sdk) {
        sdk.onAuth = handler;
        return;
    }
    try {
        handler?.(LOCAL_USER);
    } catch (err) {
        log('pdf', 'auth handler failed', String(err));
    }
}

export const canSignOut = () => !!authSdk() && !isApp();

export async function signOut() {
    if (isApp()) return;
    const auth = authSdk();
    if (!auth) {
        log('pdf', 'signOut ignored: local edition has no account session');
        return;
    }
    await auth.signOut();
}

export async function listFiles() {
    const fs = fsSdk();
    if (fs) {
        try {
            return (await fs.readdir(FOLDER))
                .filter((f) => !f.is_dir && !f.isDir && /\.pdf$/i.test(f.name))
                .map((f) => ({ ...f, path: f.path || `${FOLDER}/${f.name}` }));
        } catch (err) {
            if (isNotFound(err)) return [];
            log('pdf', 'listFiles failed', String(err));
            throw err;
        }
    }
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
    const fs = fsSdk();
    const file = fs ? await fs.read(path) : await S.readFile(path);
    signal?.throwIfAborted();
    if (file.size > maxBytes) throw new Error(`Choose a PDF smaller than ${maxBytes / (1024 * 1024)} MB.`);
    const bytes = await file.arrayBuffer();
    signal?.throwIfAborted();
    return new Uint8Array(bytes);
}

export async function saveFile(name, bytes, path = null) {
    const blob = new Blob([bytes], { type: 'application/pdf' });
    const fs = fsSdk();
    if (fs) {
        const item = await fs.write(path || `${FOLDER}/${safeName(name)}`, blob, {
            overwrite: !!path,
            dedupeName: !path,
            createMissingParents: true,
        });
        log('pdf', 'saved', item?.path || path || name);
        return item;
    }
    const target = path || `${FOLDER}/${safeName(name)}`;
    if (!path && await statFile(target)) {
        const stem = safeName(name).replace(/\.pdf$/i, '');
        let n = 2;
        while (await statFile(`${FOLDER}/${stem} ${n}.pdf`)) n += 1;
        return saveFile(`${stem} ${n}.pdf`, bytes, null);
    }
    await S.writeFile(target, blob);
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
    const ui = uiSdk();
    if (ui) return ui.showOpenFilePicker({ accept: '.pdf', multiple: false });
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
    const ui = uiSdk();
    if (ui) return ui.showSaveFilePicker(blob, safeName(name));
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
    const fs = fsSdk();
    if (fs) return fs.delete(path);
    await S.deleteFile(path);
}

export async function renameFile(path, name) {
    const fs = fsSdk();
    if (fs) return fs.rename(path, safeName(name));
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

export const canStat = () => {
    const fs = fsSdk();
    return fs ? typeof fs.stat === 'function' : true;
};

export async function statFile(target) {
    const fs = fsSdk();
    if (fs) {
        try {
            return fileInfo(await fs.stat(target));
        } catch (error) {
            if (isNotFound(error)) return null;
            throw error;
        }
    }
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
    const fs = fsSdk();
    const file = fs ? await fs.read(path) : await S.readFile(path);
    signal?.throwIfAborted();
    if (file.size > maxBytes) throw new Error(`Choose a file smaller than ${maxBytes / (1024 * 1024)} MB.`);
    return file;
}

let windowTitle = null;
export function setWindowTitle(title) {
    // A web page owns document.title ("<name> · PDF Editor"); only a desktop
    // window passes the bare file name to its shell.
    if (!isApp() || title === windowTitle) return;
    try {
        globalThis.puter.ui?.setWindowTitle?.(title);
        windowTitle = title;
    } catch {
        log('pdf', 'setWindowTitle skipped: no window');
    }
}

export function onWindowClose(handler) {
    if (!isApp() || typeof globalThis.puter?.ui?.onWindowClose !== 'function') return false;
    globalThis.puter.ui.onWindowClose(handler);
    return true;
}

export function exitApp() {
    if (isApp()) globalThis.puter?.exit?.();
    else log('pdf', 'exitApp ignored: local edition is a web page');
}
