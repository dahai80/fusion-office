/**
 * Everything the app asks of its environment, in one place: local storage
 * (File System Access API with an OPFS fallback) and fusion-gateway for AI.
 * The name and shape are kept from the Puter edition so the rest of the code
 * needs no changes at every call site.
 *
 *  auth      a single local user; no sign-in is needed
 *  env       'app' for the local edition; a page SDK may name another one
 *  files     documents as real .docx files under /Documents
 *  pickers   the browser's open/save dialogs, imported into /Documents
 *  ai        chat through fusion-gateway on 127.0.0.1:11432
 */

import * as S from '@fusion-office/storage';
import * as AI from '@fusion-office/ai-client';
import { log } from '@fusion-office/storage';
import { documentRoot, rememberDocumentRoot, learnDocumentPath } from './document-paths.js';

export const FOLDER = 'Documents';

const testSdk = () => (globalThis.puter?.fs ? globalThis.puter : null);

function fsReaddir(path) {
  const sdk = testSdk();
  if (sdk) return sdk.fs.readdir(path);
  return S.readdir(path);
}

async function fsRead(path) {
  const sdk = testSdk();
  const blob = sdk ? await sdk.fs.read(path) : await S.readFile(path);
  return blob instanceof Blob ? blob : new Blob([blob]);
}

async function fsWrite(path, blob, options = {}) {
  const sdk = testSdk();
  if (sdk) {
    return sdk.fs.write(path, blob, {
      overwrite: options.overwrite ?? !options.dedupe,
      dedupeName: !!options.dedupe,
      createMissingParents: true,
    });
  }
  await S.writeFile(path, blob);
  return { path };
}

async function fsDelete(path, recursive) {
  const sdk = testSdk();
  if (sdk) return sdk.fs.delete(path, recursive ? { recursive: true } : undefined);
  return S.deleteFile(path);
}

function fsRename(path, newName) {
  const sdk = testSdk();
  return sdk ? sdk.fs.rename(path, newName) : S.rename(path, `${path.slice(0, path.lastIndexOf('/') + 1)}${newName}`);
}

function fsStat(path) {
  const sdk = testSdk();
  return sdk ? sdk.fs.stat(path) : S.stat(path);
}
export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export const OPENABLE = /\.(docx|dotx|docm|hwp|hwpx)$/i;
export const DOCUMENT_EXTENSIONS = ['.docx', '.dotx', '.docm', '.hwp', '.hwpx'];
export const IMPORTABLE = /\.(docx|dotx|docm|hwp|hwpx|md|markdown|txt|html?)$/i;
export const IMPORT_ACCEPT = '.docx,.dotx,.docm,.hwp,.hwpx,.md,.markdown,.txt,.html,.htm,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/x-hwp,application/haansofthwp,application/vnd.hancom.hwp,application/hwp+zip,text/markdown,text/plain,text/html';
export const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp' };
export const IMAGE_EXTENSIONS = Object.keys(IMAGE_TYPES);

export function mimeFor(name) {
  const m = /\.[^./\\]+$/.exec(String(name || ''));
  if (m && /\.hwp$/i.test(m[0])) return 'application/x-hwp';
  if (m && /\.hwpx$/i.test(m[0])) return 'application/hwp+zip';
  return (m && IMAGE_TYPES[m[0].toLowerCase()]) || (m && OPENABLE.test(m[0]) ? DOCX_MIME : '');
}

const pathLookups = new WeakMap();

export async function prepareDocumentPaths(owner = testSdk()) {
  if (!owner?.fs?.stat || documentRoot(owner)) return;
  if (!pathLookups.has(owner)) pathLookups.set(owner, (async () => {
    try { rememberDocumentRoot((await owner.fs.stat(FOLDER))?.path, owner); }
    catch { /* Local settings must not prevent opening a file. */ }
  })().finally(() => pathLookups.delete(owner)));
  await pathLookups.get(owner);
}

export function hasSDK() {
  return !!testSdk();
}

export function env() {
  return globalThis.puter?.env || 'app';
}

export function isApp() {
  return env() === 'app';
}

/* ---------- Auth ---------- */

const LOCAL_USER = Object.freeze({ username: 'local', email: '', full_name: 'Local user' });

const authSdk = () => (globalThis.puter?.auth ? globalThis.puter : null);

export async function isSignedIn() {
  const sdk = authSdk();
  if (!sdk) return true;
  try {
    return !!(await Promise.resolve(sdk.auth.isSignedIn()));
  } catch {
    return false;
  }
}

export async function signIn() {
  const sdk = authSdk();
  if (!sdk) return true;
  await sdk.auth.signIn();
  return true;
}

export function signOut() {
  const sdk = authSdk();
  if (!sdk) {
    log('documents', 'signOut ignored: local edition has no account session');
    return undefined;
  }
  return sdk.auth.signOut?.();
}

export async function getUser() {
  const sdk = authSdk();
  if (!sdk) return LOCAL_USER;
  try {
    return await sdk.auth.getUser();
  } catch {
    return null;
  }
}

export async function getProfilePicture() {
  const sdk = authSdk();
  if (!sdk) return null;
  try {
    const picture = await sdk.auth.getProfilePicture?.();
    return typeof picture === 'string' && /^data:image\/[a-z0-9.+-]+;base64,/i.test(picture) ? picture : null;
  } catch {
    return null;
  }
}

export function onAuth(handler) {
  const sdk = authSdk();
  if (sdk) {
    sdk.onAuth = handler;
    return;
  }
  try {
    handler?.(LOCAL_USER);
  } catch (err) {
    log('documents', 'auth handler failed', String(err));
  }
}

/* ---------- Names ---------- */

export function isNotFound(err) {
  const code = err?.code || err?.error?.code || '';
  const msg = String(err?.message || err?.error?.message || err || '').toLowerCase();
  return code === 'subject_does_not_exist' || code === 'ENOENT' || code === 'NotFoundError'
    || msg.includes('not found') || msg.includes('does not exist') || msg.includes('no such')
    || msg.includes('could not be found');
}

export function displayName(path) {
  return String(path || '').split('/').pop();
}

export function stripExtension(name) {
  return String(name || '').replace(/\.[^./\\]+$/, '');
}

export function documentStem(name) {
  return sanitizeName(String(name || '').replace(/\.docx$/i, ''));
}

export function sanitizeName(name) {
    const clean = String(name || '').replace(/[/\\]/g, ' ').replace(/[\x00-\x1f\x7f\u200b\u200e\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g, '').trim().slice(0, 200).replace(/[\ud800-\udbff]$/, '').trim();
  return /^\.+$/.test(clean) ? '' : clean;
}

export function ensureDocx(name) {
  const clean = sanitizeName(name);
  return /\.docx$/i.test(clean) ? clean : `${clean}.docx`;
}

/* ---------- Files ---------- */

const isDirectory = (it) => !!(it.isDir ?? it.is_dir ?? it.kind === 'directory');
const itemModified = (it) => it.modified ?? it.mtime ?? 0;
const itemKind = (it) => (isDirectory(it) ? 'directory' : 'file');

export async function listFiles() {
  let items;
  try {
    items = await fsReaddir(FOLDER);
  } catch (err) {
    if (isNotFound(err)) return [];
    log('documents', 'listFiles failed', String(err));
    throw err;
  }
  const sdk = testSdk();
  if (sdk) {
    const listed = (items || []).find((it) => it?.name && !it.name.includes('/') && it.path?.startsWith('/'));
    if (listed) learnDocumentPath(`${FOLDER}/${listed.name}`, listed.path, sdk);
    await prepareDocumentPaths(sdk);
  }
  return items
    .filter((it) => !isDirectory(it) && OPENABLE.test(it.name))
    .map((it) => ({
      name: it.name,
      path: it.path || `${FOLDER}/${it.name}`,
      size: it.size ?? 0,
      modified: itemModified(it),
      uid: it.uid || it.id || it.path || null,
    }))
    .sort((a, b) => (b.modified || 0) - (a.modified || 0));
}

export async function readFile(path) {
  return fsRead(path);
}

export async function writeFile(path, blob, options = {}) {
  const result = await fsWrite(path, blob, options);
  return {
    name: result?.name || displayName(path),
    path: result?.path || path,
    size: blob?.size ?? 0,
    modified: result?.modified ?? Date.now(),
  };
}

export async function createFile(path, blob) {
  return (await createFileWithMetadata(path, blob)).path;
}

export async function createFileWithMetadata(path, blob) {
  const folder = path.slice(0, path.lastIndexOf('/')) || FOLDER;
  let target = path;
  if (testSdk()) {
    const item = await fsWrite(target, blob, { dedupe: true });
    const name = item?.name || displayName(item?.path || target);
    target = `${path.slice(0, path.lastIndexOf('/') + 1)}${name}`;
    learnDocumentPath(target, item?.path, testSdk());
    log('documents', 'created file', target);
    return { path: target, modified: item?.modified ?? null };
  }
  if (await fileExists(target)) {
    const name = await uniqueName(displayName(path));
    target = `${folder}/${name}`;
  }
  const item = await writeFile(target, blob);
  log('documents', 'created file', target);
  return { path: target, modified: item.modified };
}

export async function deleteFile(path) {
  await fsDelete(path, false);
}

export async function deleteFolder(path) {
  await fsDelete(path, true);
}

export async function listFolder(path) {
  let items;
  try {
    items = await fsReaddir(path);
  } catch (err) {
    if (isNotFound(err)) return [];
    log('documents', 'listFolder failed', String(err));
    throw err;
  }
  return items.map((it) => ({
    name: it.name,
    path: it.path || `${path}/${it.name}`,
    size: it.size ?? 0,
    modified: itemModified(it),
    isDir: isDirectory(it),
  }));
}

export async function renameFile(path, newName) {
  const folder = path.slice(0, path.lastIndexOf('/')) || FOLDER;
  const target = `${folder}/${sanitizeName(newName)}`;
  if (target === path) return { path, modified: (await statFile(path))?.modified ?? null };
  const result = await fsRename(path, sanitizeName(newName));
  return {
    name: displayName(target),
    path: result?.path || target,
    size: result?.size ?? 0,
    modified: result?.modified ?? Date.now(),
  };
}

export async function statFile(path) {
  let item;
  try {
    item = await fsStat(path);
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
  if (!item) return null;
  return {
    name: item.name || displayName(path),
    path: item.path || path,
    size: item.size ?? 0,
    modified: itemModified(item),
    isDir: isDirectory(item),
  };
}

export async function fileExists(path) {
  return !!(await statFile(path));
}

export async function uniqueName(base) {
  const stem = stripExtension(base) || 'Untitled document';
  let name = `${stem}.docx`;
  if (!await fileExists(`${FOLDER}/${name}`)) return name;
  let names;
  try { names = new Set((await listFolder(FOLDER)).map((item) => item.name)); }
  catch { log('documents', 'uniqueName could not list folder, using stat checks'); }
  let n = 2;
  do { name = `${stem} ${n++}.docx`; }
  while (names ? names.has(name) : await fileExists(`${FOLDER}/${name}`));
  return name;
}

/* ---------- Pickers ---------- */

const uiSdk = () => (globalThis.puter?.ui ? globalThis.puter : null);

export function canPickFiles() {
  const sdk = uiSdk();
  if (sdk) return typeof sdk.ui.showOpenFilePicker === 'function';
  return typeof showOpenFilePicker === 'function' || typeof document !== 'undefined';
}

export function canSaveFiles() {
  const sdk = uiSdk();
  if (sdk) return typeof sdk.ui.showSaveFilePicker === 'function';
  return typeof showSaveFilePicker === 'function';
}

async function importPicked(file) {
  if (!file) return null;
  const name = sanitizeName(file.name) || 'Imported file';
  let path = `${FOLDER}/${name}`;
  if (await fileExists(path)) path = `${FOLDER}/${await uniqueName(name)}`;
  await S.writeFile(path, file);
  log('documents', 'imported picked file', path);
  return { path, name: displayName(path), item: { path, name: displayName(path) } };
}

export async function pickFile({ accept = DOCUMENT_EXTENSIONS } = {}) {
  if (!canPickFiles()) return null;
  const sdk = uiSdk();
  if (sdk) {
    let result;
    try {
      result = await sdk.ui.showOpenFilePicker({ multiple: false, accept });
    } catch {
      return null;
    }
    const item = Array.isArray(result) ? result[0] : result;
    if (!item) return null;
    return { path: item.path, name: item.name || displayName(item.path), item };
  }
  let picked;
  try {
    picked = await S.pickOpenFile([{ description: 'Documents', extensions: accept }]);
  } catch (err) {
    if (!/abort|cancel/i.test(String(err?.name || err?.message))) log('documents', 'pickFile failed', String(err));
    return null;
  }
  const file = picked?.file || (picked?.handle ? await picked.handle.getFile() : null);
  return importPicked(file);
}

export async function pickImage() {
  const picked = await pickFile({ accept: IMAGE_EXTENSIONS });
  if (!picked) return null;
  const blob = await readFile(picked.path);
  return new File([blob], picked.name, { type: blob.type || mimeFor(picked.name) || 'application/octet-stream' });
}

export async function saveFileAs(blob, suggestedName) {
  const sdk = uiSdk();
  if (sdk) {
    if (!canSaveFiles()) return null;
    const item = await sdk.ui.showSaveFilePicker(blob, suggestedName);
    if (!item) return null;
    return { path: item.path, name: item.name || displayName(item.path) };
  }
  if (canSaveFiles()) {
    try {
      const picked = await S.pickSaveFile(suggestedName);
      if (!picked?.handle) return null;
      const writable = await picked.handle.createWritable();
      await writable.write(blob);
      await writable.close();
      const name = picked.handle.name || suggestedName;
      log('documents', 'saved copy', name);
      return { path: name, name };
    } catch (err) {
      if (/abort|cancel/i.test(String(err?.name || err?.message))) return null;
      log('documents', 'saveFileAs failed, downloading instead', String(err));
    }
  }
  await S.downloadFallback(suggestedName, blob);
  return { path: suggestedName, name: suggestedName };
}

/* ---------- Small per-user settings ---------- */

const kvSdk = () => (globalThis.puter?.kv ? globalThis.puter : null);

export function canUseKv() {
  return true;
}

export async function kvGet(key) {
  try {
    const sdk = kvSdk();
    const value = sdk ? await sdk.kv.get(key) : await S.get(key);
    return value ?? null;
  } catch (err) {
    log('documents', 'kvGet failed', key, String(err));
    return null;
  }
}

export async function kvSet(key, value) {
  try {
    const sdk = kvSdk();
    if (sdk) await sdk.kv.set(key, value);
    else await S.set(key, value);
  } catch (err) {
    log('documents', 'kvSet failed', key, String(err));
    throw err;
  }
}

/* ---------- AI ---------- */

export function canUseAi() {
  return true;
}

function aiMessages(prompt, options) {
  if (typeof options === 'string' && options.startsWith('data:image/')) {
    return [{
      role: 'user',
      content: [
        { type: 'text', text: String(prompt) },
        { type: 'image_url', image_url: { url: options } },
      ],
    }];
  }
  if (options && Array.isArray(options.messages)) return options.messages;
  return [{ role: 'user', content: String(prompt) }];
}

export async function aiChat(prompt, options = {}) {
  const harness = globalThis.puter?.ai;
  if (harness?.chat) {
    const result = await harness.chat(String(prompt));
    const text = String(result?.message?.content ?? result);
    log('documents', 'aiChat ok through the dev harness', text.length, 'chars');
    return { message: { role: 'assistant', content: text } };
  }
  const messages = aiMessages(prompt, options);
  const text = await AI.chat({ messages, model: typeof options === 'object' ? options.model : undefined });
  log('documents', 'aiChat ok', text.length, 'chars');
  return { message: { role: 'assistant', content: text } };
}

export function canMakeImages() {
  return false;
}

export function makeImage() {
  return Promise.reject(new Error('Image generation is not available through fusion-gateway'));
}

export function canSpeak() {
  return false;
}

export function speak() {
  return Promise.reject(new Error('Speech synthesis is not available through fusion-gateway'));
}

/* ---------- Hosting ---------- */

export function canHost() {
  return !!testSdk()?.hosting;
}

export function hostingCreate(subdomain, dir) {
  const hosting = testSdk()?.hosting;
  if (!hosting) return Promise.reject(new Error('Publishing is not available in the local edition'));
  return hosting.create(subdomain, dir);
}

export function hostingUpdate(subdomain, dir) {
  const hosting = testSdk()?.hosting;
  if (!hosting) return Promise.reject(new Error('Publishing is not available in the local edition'));
  return hosting.update(subdomain, dir);
}

export function hostingDelete(subdomain) {
  const hosting = testSdk()?.hosting;
  if (!hosting) return Promise.reject(new Error('Publishing is not available in the local edition'));
  return hosting.delete(subdomain);
}

/* ---------- Desktop integration ---------- */

export function setWindowTitle(title) {
  try { document.title = String(title || 'Documents'); } catch { /* no document */ }
}

export function onLaunchedWithItems() {
  return undefined;
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
