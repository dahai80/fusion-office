import { cleanName, MIME, validateImportSize } from "./model.js";
import * as S from "@fusion-office/storage";
import * as AI from "@fusion-office/ai-client";

// Files live under the Presentation folder of the local workspace. A shell or a
// browser test may put an SDK on the page; it then answers the calls the app
// makes instead of local storage.
export const FOLDER = "Presentations";

const LOCAL_USER = { username: "local", name: "Local User" };

const pageSdk = () => globalThis.puter || null;
const fsSdk = () => globalThis.puter?.fs || null;
const authSdk = () => globalThis.puter?.auth || null;
const uiSdk = () => globalThis.puter?.ui || null;
const aiSdk = () => globalThis.puter?.ai || null;

export const isApp = () => globalThis.puter?.env === "app";
export const canSignOut = () => !!authSdk() && !isApp();

export async function user() {
    const auth = authSdk();
    if (!auth) return LOCAL_USER;
    try {
        if (await auth.isSignedIn()) return await auth.getUser();
    } catch (e) {
        S.log("cloud", "user failed", String(e));
    }
    return null;
}

export async function profilePicture() {
    const auth = authSdk();
    if (!auth) return null;
    try {
        return (await auth.getProfilePicture?.()) || null;
    } catch {
        return null;
    }
}

export async function signIn() {
    const auth = authSdk();
    if (!auth) {
        S.log("cloud", "local session, no sign-in required");
        return LOCAL_USER;
    }
    try {
        await auth.signIn();
    } catch (error) {
        if (error?.error === "auth_window_closed")
            throw Object.assign(new Error("Sign-in was cancelled."), {
                code: "cancelled",
            });
        if (error?.error === "popup_blocked")
            throw new Error(
                "The browser blocked the sign-in window. Allow pop-ups for this site and try again.",
                { cause: error },
            );
        if (error instanceof Error) throw error;
        throw new Error(
            error?.msg || error?.message || "Sign-in failed. Please try again.",
            { cause: error },
        );
    }
    return auth.getUser();
}

export async function signOut() {
    if (!canSignOut()) {
        S.log("cloud", "sign-out ignored: no account session");
        return;
    }
    await authSdk().signOut();
}

export function onAuth(handler) {
    const sdk = pageSdk();
    if (sdk) sdk.onAuth = handler;
}

export async function listFiles() {
    const fs = fsSdk();
    if (fs) {
        try {
            return (await fs.readdir(FOLDER))
                .filter((f) => !f.is_dir && /\.pptx$/i.test(f.name))
                .map((f) => ({ ...f, path: f.path || `${FOLDER}/${f.name}` }));
        } catch (e) {
            if (isNotFound(e)) return [];
            throw e;
        }
    }
    let entries;
    try {
        entries = await S.readdir(FOLDER);
    } catch (e) {
        if (isNotFound(e)) return [];
        throw e;
    }
    return entries
        .filter((entry) => entry.kind === "file" && /\.pptx$/i.test(entry.name))
        .map((entry) => ({
            path: entry.path,
            name: entry.name,
            is_dir: false,
            size: entry.size,
            modified: entry.mtime,
            created: entry.mtime,
        }));
}

export function isNotFound(error) {
    const code = error?.code || error?.error?.code || "";
    const name = String(error?.name || "");
    const message = String(
        error?.message || error?.error?.message || error?.msg || "",
    ).toLowerCase();
    return (
        name === "NotFoundError" ||
        code === "subject_does_not_exist" ||
        code === "ENOENT" ||
        message.includes("not found") ||
        message.includes("could not be found") ||
        message.includes("does not exist") ||
        message.includes("no such")
    );
}

export const displayName = (path) => String(path || "").split("/").pop();
export const isPptxName = (name) => /\.pptx$/i.test(String(name || ""));

export const inTrash = (path) =>
    typeof path === "string" && /^(?:\/[^/]+|~)\/Trash(?:\/|$)/.test(path);

export const isDirItem = (item) =>
    !!(item?.is_dir || item?.isDirectory || item?.isDir || item?.fsentry_is_dir);

export function folderName(path) {
    const parts = String(path || "").split("/");
    return parts.length > 2 ? parts.at(-2) : "";
}

export function inAppFolder(path) {
    const parts = String(path || "").split("/");
    return parts.length >= 2 && parts.at(-2) === FOLDER;
}

export function modifiedMs(item) {
    const m = item?.modified ?? item?.created;
    if (m == null || m === "") return null;
    const n = typeof m === "number" ? m : Number(m) || new Date(m).getTime();
    if (!Number.isFinite(n) || n <= 0) return null;
    return n < 1e12 ? n * 1000 : n;
}

export function sizeOf(item) {
    const size = Number(item?.size);
    return Number.isFinite(size) && size > 0 ? size : null;
}

export const canStat = () => {
    const fs = fsSdk();
    return fs ? typeof fs.stat === "function" : true;
};
export const canStatByUid = () => {
    const fs = fsSdk();
    return fs ? typeof fs.stat === "function" : false;
};

const infoOf = (path, info) => ({
    path,
    name: info.name,
    size: info.size,
    modified: info.mtime,
    is_dir: info.kind === "directory",
});

export async function stat(path) {
    const fs = fsSdk();
    if (fs) {
        try {
            return await fs.stat(path);
        } catch (e) {
            if (isNotFound(e)) return null;
            throw e;
        }
    }
    const info = await S.stat(path);
    return info ? infoOf(path, info) : null;
}

export async function statByUid(uid) {
    const fs = fsSdk();
    if (!uid || !fs || typeof fs.stat !== "function") return null;
    try {
        return await fs.stat({ uid });
    } catch (e) {
        if (isNotFound(e)) return null;
        throw e;
    }
}

function abortError() {
    return new DOMException("The operation was aborted.", "AbortError");
}

export async function readFile(path, { importing = false, signal } = {}) {
    if (signal?.aborted) throw abortError();
    const fs = fsSdk();
    const file = fs ? await fs.read(path) : await S.readFile(path);
    if (importing) validateImportSize(file.size);
    const buffer = await file.arrayBuffer();
    if (signal?.aborted) throw abortError();
    return new Uint8Array(buffer);
}

async function freePath(name) {
    const stem =
        cleanName(name, { stripExtension: true, maxLength: Infinity }) ||
        "Presentation";
    let candidate = `${FOLDER}/${stem}.pptx`;
    for (let n = 2; await S.stat(candidate); n++) {
        candidate = `${FOLDER}/${stem} ${n}.pptx`;
    }
    return candidate;
}

export async function saveFile(bytes, name, path = null) {
    const blob = new Blob([bytes], { type: MIME });
    const fs = fsSdk();
    if (fs) {
        const item = await fs.write(
            path ||
                `${FOLDER}/${cleanName(name, { stripExtension: false, maxLength: Infinity })}.pptx`,
            blob,
            { overwrite: !!path, dedupeName: !path, createMissingParents: true },
        );
        S.log("cloud", "saved through the page SDK", item?.path || path || name);
        return item;
    }
    const target = path || (await freePath(name));
    await S.writeFile(target, blob);
    S.log("cloud", "saved", target, blob.size);
    return {
        path: target,
        name: target.split("/").pop(),
        size: blob.size,
        modified: Date.now(),
    };
}

export async function renameFile(path, name) {
    const fs = fsSdk();
    const fileName = `${cleanName(name)}.pptx`;
    const target = path.slice(0, path.lastIndexOf("/") + 1) + fileName;
    if (fs) {
        if (canStat() && target.toLowerCase() !== path.toLowerCase() && (await stat(target)))
            throw Object.assign(
                new Error(
                    `A file named “${fileName}” is already in that folder. Choose another name.`,
                ),
                { code: "exists" },
            );
        return fs.rename(path, fileName);
    }
    if (target !== path) {
        const same = target.toLowerCase() === path.toLowerCase();
        if (!same && (await S.stat(target))) {
            throw Object.assign(
                new Error(
                    `A file named “${fileName}” is already in that folder. Choose another name.`,
                ),
                { code: "exists" },
            );
        }
        if (same) {
            // A case-only rename on a case-insensitive disk would delete the
            // file it just wrote, so it goes through a distinct temporary name.
            const bytes = await S.readFile(path);
            const temp = `${target}.rename-${Date.now()}`;
            await S.writeFile(temp, bytes);
            await S.deleteFile(path);
            await S.writeFile(target, bytes);
            await S.deleteFile(temp);
        } else {
            await S.rename(path, target);
        }
    }
    const info = await S.stat(target);
    S.log("cloud", "renamed", path, "->", target);
    return info ? infoOf(target, info) : { path: target, name: fileName };
}

export async function deleteFile(path) {
    const fs = fsSdk();
    if (fs) return fs.delete(path);
    await S.deleteFile(path);
    S.log("cloud", "deleted", path);
}

export const canPickFiles = () => {
    const ui = uiSdk();
    return ui ? typeof ui.showOpenFilePicker === "function" : true;
};
export const canSaveFiles = () => {
    const ui = uiSdk();
    return ui
        ? typeof ui.showSaveFilePicker === "function"
        : typeof globalThis.showSaveFilePicker === "function";
};

const settleOnCancel = (pending) => pending?.undefinedOnCancel ?? pending;

export async function pickFile({ accept = [".pptx"] } = {}) {
    const ui = uiSdk();
    if (ui) {
        const item = await settleOnCancel(
            ui.showOpenFilePicker({ multiple: false, accept }),
        );
        return (Array.isArray(item) ? item[0] : item) || null;
    }
    let picked;
    try {
        picked = await S.pickOpenFile([
            { description: "PowerPoint", extensions: accept },
        ]);
    } catch (e) {
        if (e?.name === "AbortError") return null;
        throw e;
    }
    const file = picked?.file;
    if (!file) return null;
    const path = await freePath(file.name || "Presentation");
    await S.writeFile(path, file);
    S.log("cloud", "imported", file.name, "->", path);
    return {
        path,
        name: path.split("/").pop(),
        size: file.size,
        modified: file.lastModified || Date.now(),
    };
}

export async function saveFileAs(blob, suggestedName) {
    const ui = uiSdk();
    if (ui) {
        const item = await settleOnCancel(
            ui.showSaveFilePicker(blob, suggestedName),
        );
        return item || null;
    }
    if (!canSaveFiles()) return null;
    let picked;
    try {
        picked = await S.pickSaveFile(suggestedName, [
            { description: "PowerPoint", extensions: [".pptx"] },
        ]);
    } catch (e) {
        if (e?.name === "AbortError") return null;
        throw e;
    }
    if (!picked?.handle) return null;
    const writable = await picked.handle.createWritable();
    await writable.write(blob);
    await writable.close();
    S.log("cloud", "saved as", suggestedName, blob.size);
    return { path: suggestedName, name: suggestedName, size: blob.size, modified: Date.now() };
}

export function onLaunch(handler) {
    const ui = uiSdk();
    if (!ui) return;
    try {
        ui.onLaunchedWithItems?.((items) => {
            const list = (Array.isArray(items) ? items : [items]).filter(Boolean);
            if (list.length) handler(list);
        });
    } catch (e) {
        S.log("cloud", "onLaunch failed", String(e));
    }
}

export function setWindowTitle(title) {
    // The page owns document.title ("<name> | Presentation"); a desktop window
    // passes the bare presentation name to the shell instead.
    if (!isApp()) return;
    try {
        globalThis.puter.ui?.setWindowTitle?.(title)?.catch?.(() => {});
    } catch {
    }
}

export function onWindowClose(handler) {
    const ui = uiSdk();
    if (
        !isApp() ||
        typeof ui?.onWindowClose !== "function" ||
        typeof globalThis.puter?.exit !== "function"
    )
        return false;
    try {
        ui.onWindowClose(handler);
        return true;
    } catch {
        return false;
    }
}

export function exitApp() {
    if (!isApp()) return;
    try {
        globalThis.puter?.exit?.();
    } catch {
    }
}

export async function download(bytes, name) {
    return downloadBlob(
        new Blob([bytes], { type: MIME }),
        `${cleanName(name, { stripExtension: false, maxLength: Infinity })}.pptx`,
    );
}

export async function downloadBlob(blob, filename) {
    if (isApp() && canSaveFiles()) {
        const saved = await saveFileAs(blob, filename);
        return saved ? { saved } : { cancelled: true };
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    S.log("cloud", "download", filename, blob.size);
    return { downloaded: true };
}

export class SaveQueue {
    constructor() {
        this.tail = Promise.resolve();
    }
    run(work) {
        const next = this.tail.then(work);
        this.tail = next.catch(() => {});
        return next;
    }
}

export const canAI = () => {
    const ai = aiSdk();
    return ai ? typeof ai.chat === "function" : true;
};

export async function* aiChatStream(messages, { model, tools, maxTokens } = {}) {
    const ai = aiSdk();
    if (ai) {
        yield* sdkChatStream(ai, messages, { model, tools, maxTokens });
        return;
    }
    try {
        for await (const event of AI.chatStreamEvents({
            messages,
            model,
            tools,
            maxTokens,
        })) {
            if (event.type === "text" && event.text)
                yield { type: "text", text: event.text };
            else if (event.type === "tool")
                yield {
                    type: "tool",
                    id: event.id,
                    name: event.name,
                    input: event.input ?? {},
                };
        }
    } catch (e) {
        throw aiError(e);
    }
}

async function* sdkChatStream(ai, messages, { model, tools, maxTokens } = {}) {
    const options = {
        stream: true,
        ...(model ? { model } : {}),
        ...(tools?.length ? { tools } : {}),
        ...(maxTokens ? { max_tokens: maxTokens } : {}),
    };
    let res;
    try {
        res = await ai.chat(messages, options);
    } catch (e) {
        throw aiError(e);
    }
    if (res && typeof res[Symbol.asyncIterator] === "function") {
        try {
            for await (const part of res) {
                if (!part) continue;
                if (part.type === "error" || (part.success === false && part.error))
                    throw aiError(part.error || part);
                if (part.type === "tool_use")
                    yield {
                        type: "tool",
                        id: part.id,
                        name: part.name,
                        input: part.input ?? {},
                    };
                else if (
                    typeof part.text === "string" &&
                    part.text &&
                    part.type !== "reasoning"
                )
                    yield { type: "text", text: part.text };
            }
        } catch (e) {
            throw aiError(e);
        }
        return;
    }
    if (res?.success === false) throw aiError(res.error || res);
    const message = res?.message || {};
    const content = typeof res === "string" ? res : message.content;
    const text =
        typeof content === "string"
            ? content
            : Array.isArray(content)
                ? content
                      .map((c) => (typeof c === "string" ? c : c?.text || ""))
                      .join("")
                : "";
    if (text) yield { type: "text", text };
    for (const call of message.tool_calls || []) {
        let input = call.function?.arguments ?? {};
        if (typeof input === "string") {
            try {
                input = input.trim() ? JSON.parse(input) : {};
            } catch {
                input = { __unreadable: input };
            }
        }
        yield { type: "tool", id: call.id, name: call.function?.name, input };
    }
}

export async function aiChat(prompt, image, _testMode, options = {}) {
    const ai = aiSdk();
    if (ai) {
        // The host SDK takes the question, an optional picture, the test flag,
        // and the options positionally.
        try {
            const res = image
                ? await ai.chat(prompt, image, false, options)
                : await ai.chat(prompt, false, options);
            const text = String(res?.message?.content ?? res);
            S.log("cloud", "aiChat ok through the page SDK", text.length, "chars");
            return { message: { role: "assistant", content: text } };
        } catch (e) {
            throw aiError(e);
        }
    }
    const content = image
        ? [
              { type: "text", text: prompt },
              { type: "image_url", image_url: { url: image } },
          ]
        : prompt;
    try {
        const text = await AI.chat({
            messages: [{ role: "user", content }],
            model: options.model,
        });
        return { message: { role: "assistant", content: text } };
    } catch (e) {
        throw aiError(e);
    }
}

function aiError(e) {
    if (e instanceof Error) return e;
    const inner = e?.error && typeof e.error === "object" ? e.error : e;
    const message =
        inner?.message ||
        (typeof e?.error === "string" ? e.error : "") ||
        (typeof e === "string" ? e : "") ||
        "The AI did not answer.";
    return Object.assign(new Error(message), { code: inner?.code || e?.code });
}
