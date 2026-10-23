import { cleanName, MIME, validateImportSize } from "./model.js";
import * as S from "@fusion-office/storage";
import * as AI from "@fusion-office/ai-client";

// Files live under the Presentation folder of the local workspace.
export const FOLDER = "Presentations";

const LOCAL_USER = { username: "local", name: "Local User" };

export const isApp = () => false;
export const canSignOut = () => false;

export async function user() {
    return LOCAL_USER;
}

export async function profilePicture() {
    return null;
}

export async function signIn() {
    S.log("cloud", "local session, no sign-in required");
    return LOCAL_USER;
}

export async function signOut() {
    S.log("cloud", "local session, sign-out is a no-op");
}

export function onAuth() {
}

export async function listFiles() {
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

export const isDirItem = (item) => item?.is_dir === true;

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

export const canStat = () => true;
export const canStatByUid = () => false;

const infoOf = (path, info) => ({
    path,
    name: info.name,
    size: info.size,
    modified: info.mtime,
    is_dir: info.kind === "directory",
});

export async function stat(path) {
    const info = await S.stat(path);
    return info ? infoOf(path, info) : null;
}

export async function statByUid() {
    // The local store addresses files by path; there are no stable ids to
    // follow a file moved outside the app.
    return null;
}

function abortError() {
    return new DOMException("The operation was aborted.", "AbortError");
}

export async function readFile(path, { importing = false, signal } = {}) {
    if (signal?.aborted) throw abortError();
    const file = await S.readFile(path);
    if (importing) validateImportSize(file.size);
    const buffer = await file.arrayBuffer();
    if (signal?.aborted) throw abortError();
    return new Uint8Array(buffer);
}

async function freePath(name) {
    const stem = cleanName(name, { stripExtension: true, maxLength: Infinity }) || "Presentation";
    let candidate = `${FOLDER}/${stem}.pptx`;
    for (let n = 2; await S.stat(candidate); n++) {
        candidate = `${FOLDER}/${stem} ${n}.pptx`;
    }
    return candidate;
}

export async function saveFile(bytes, name, path = null) {
    const blob = new Blob([bytes], { type: MIME });
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
    const fileName = `${cleanName(name)}.pptx`;
    const target = path.slice(0, path.lastIndexOf("/") + 1) + fileName;
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
    await S.deleteFile(path);
    S.log("cloud", "deleted", path);
}

export const canPickFiles = () => true;
export const canSaveFiles = () => typeof globalThis.showSaveFilePicker === "function";

export async function pickFile({ accept = [".pptx"] } = {}) {
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

export function onLaunch() {
}

export function setWindowTitle(title) {
    try {
        globalThis.document.title = title;
    } catch {
    }
}

export function onWindowClose() {
    return false;
}

export function exitApp() {
}

export async function download(bytes, name) {
    return downloadBlob(
        new Blob([bytes], { type: MIME }),
        `${cleanName(name, { stripExtension: false, maxLength: Infinity })}.pptx`,
    );
}

export async function downloadBlob(blob, filename) {
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

export const canAI = () => true;

export async function* aiChatStream(messages, { model, tools, maxTokens } = {}) {
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

export async function aiChat(prompt, image, _testMode, options = {}) {
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
