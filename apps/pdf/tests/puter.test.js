import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import * as P from '../src/lib/puter.js';

const state = vi.hoisted(() => ({ files: new Map(), readdirError: null }));

vi.mock('@fusion-office/storage', () => ({
    log: () => {},
    writeFile: vi.fn(async (path, blob) => {
        state.files.set(path, blob);
    }),
    readFile: vi.fn(async (path) => {
        const file = state.files.get(path);
        if (!file) throw Object.assign(new Error('not found'), { code: 'ENOENT' });
        return file;
    }),
    readdir: vi.fn(async (path) => {
        if (state.readdirError) throw state.readdirError;
        return [...state.files]
            .filter(([filePath]) => filePath.startsWith(`${path}/`))
            .map(([filePath, blob]) => ({
                name: filePath.split('/').pop(),
                path: filePath,
                kind: 'file',
                size: blob.size,
                mtime: 0,
            }));
    }),
    stat: vi.fn(async (path) => {
        const blob = state.files.get(path);
        return blob ? { kind: 'file', name: path.split('/').pop(), size: blob.size, mtime: 0 } : null;
    }),
    rename: vi.fn(async (from, to) => {
        state.files.set(to, state.files.get(from));
        state.files.delete(from);
    }),
    deleteFile: vi.fn(async (path) => {
        state.files.delete(path);
    }),
    pickOpenFile: vi.fn(),
    pickSaveFile: vi.fn(),
    downloadFallback: vi.fn(),
}));

beforeEach(() => {
    state.files.clear();
    state.readdirError = null;
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
});

describe('local file storage', () => {
    it('stores real PDF blobs and picks a free name instead of overwriting', async () => {
        await P.saveFile('a', new Uint8Array([37, 80, 68, 70]));
        const first = state.files.get('PDF Editor/a.pdf');
        expect(first).toBeInstanceOf(Blob);
        expect(first.type).toBe('application/pdf');
        const second = await P.saveFile('a', new Uint8Array([1]));
        expect(second.path).toBe('PDF Editor/a 2.pdf');
        expect(state.files.has('PDF Editor/a.pdf')).toBe(true);
        await P.saveFile('a', new Uint8Array([1]), 'PDF Editor/a.pdf');
        expect((await state.files.get('PDF Editor/a.pdf').arrayBuffer()).byteLength).toBe(1);
    });

    it('distinguishes a missing library from permission errors', async () => {
        state.readdirError = { code: 'subject_does_not_exist' };
        expect(await P.listFiles()).toEqual([]);
        state.readdirError = new Error('Permission denied');
        await expect(P.listFiles()).rejects.toThrow('Permission denied');
    });

    it('filters directories and non-PDF files', async () => {
        state.files.set('PDF Editor/a.PDF', new Blob(['a']));
        state.files.set('PDF Editor/c.txt', new Blob(['c']));
        expect(await P.listFiles()).toEqual([
            expect.objectContaining({ name: 'a.PDF', path: 'PDF Editor/a.PDF' }),
        ]);
    });
});

describe('local session', () => {
    it('is always signed in and has a local user', async () => {
        expect(await P.isSignedIn()).toBe(true);
        expect((await P.currentUser()).username).toBe('Local workspace');
        expect(P.sessionToken()).toBeNull();
        await expect(P.signIn()).resolves.toMatchObject({ username: 'Local workspace' });
        await expect(P.signOut()).resolves.toBeUndefined();
    });

    it('hands the local user to the auth handler', () => {
        const handler = vi.fn();
        P.onAuth(handler);
        expect(handler).toHaveBeenCalledWith(expect.objectContaining({ username: 'Local workspace' }));
    });
});

describe('bounded reads', () => {
    it('rejects an oversized Blob before allocating its byte buffer', async () => {
        const arrayBuffer = vi.fn();
        state.files.set('large.pdf', { size: 100 * 1024 * 1024 + 1, arrayBuffer });
        await expect(P.readFile('large.pdf', { maxBytes: 100 * 1024 * 1024 })).rejects.toThrow(
            'Choose a PDF smaller than 100 MB.',
        );
        expect(arrayBuffer).not.toHaveBeenCalled();
    });

    it('accepts a file at the limit and preserves its bytes', async () => {
        const bytes = new Uint8Array([37, 80, 68, 70]);
        state.files.set('small.pdf', new Blob([bytes]));
        expect(await P.readFile('small.pdf', { maxBytes: bytes.length })).toEqual(bytes);
    });

    it('leaves ordinary library reads unrestricted', async () => {
        const bytes = new Uint8Array([37, 80, 68, 70]);
        state.files.set('large.pdf', new Blob([bytes]));
        expect(await P.readFile('large.pdf')).toEqual(bytes);
    });
});

it('does not request a file when its read is already cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(P.readFile('old.pdf', { signal: controller.signal })).rejects.toMatchObject({
        name: 'AbortError',
    });
});

for (const phase of ['read', 'buffer'])
    for (const cancelled of [false, true])
        it(`${cancelled ? 'cancels' : 'completes'} a read waiting for its ${phase}`, async () => {
            const controller = new AbortController();
            const bytes = new Uint8Array([37, 80, 68, 70]);
            let release, entered;
            const gate = new Promise((resolve) => {
                release = resolve;
            });
            const waiting = new Promise((resolve) => {
                entered = resolve;
            });
            const hold = async (value) => {
                entered();
                await gate;
                return value;
            };
            const arrayBuffer = vi.fn(async () => (phase === 'buffer' ? hold(bytes.buffer) : bytes.buffer));
            const file = { size: bytes.length, arrayBuffer };
            state.files.set('old.pdf', phase === 'read' ? hold(file) : file);
            const result = P.readFile('old.pdf', {
                maxBytes: bytes.length,
                signal: controller.signal,
            }).then(
                (value) => ({ value }),
                (error) => ({ error }),
            );
            await waiting;
            if (cancelled) controller.abort();
            release();
            const settled = await result;
            if (cancelled) expect(settled.error).toMatchObject({ name: 'AbortError' });
            else expect(settled.value).toEqual(bytes);
            expect(arrayBuffer).toHaveBeenCalledTimes(cancelled && phase === 'read' ? 0 : 1);
        });

describe('local files', () => {
    it('describes files, and tells a missing file from a failure', async () => {
        expect(
            P.fileInfo({ path: '/u/a.pdf', uid: 'x', size: '12', modified: 1700000000 }),
        ).toEqual({
            path: '/u/a.pdf',
            name: 'a.pdf',
            uid: 'x',
            size: 12,
            modified: 1700000000000,
            dir: false,
        });
        expect(P.fileInfo({ path: '/u/b', is_dir: true }).dir).toBe(true);
        expect(P.fileInfo(null)).toBeNull();
        state.files.set('PDF Editor/a.pdf', new Blob(['a']));
        expect(P.canStat()).toBe(true);
        expect((await P.statFile('PDF Editor/a.pdf')).name).toBe('a.pdf');
        expect(await P.statFile('PDF Editor/missing.pdf')).toBeNull();
        expect(P.inTrash('/u/Trash/a.pdf')).toBe(true);
        expect(P.inTrash('/u/Documents/Trash notes.pdf')).toBe(false);
    });

    it('leaves the page title alone and never takes over a window it could not close', () => {
        vi.stubGlobal('document', { title: 'PDF Editor' });
        expect(P.onWindowClose(() => {})).toBe(false);
        P.setWindowTitle('a.pdf');
        expect(globalThis.document.title).toBe('PDF Editor');
        P.setWindowTitle('a.pdf');
        expect(globalThis.document.title).toBe('PDF Editor');
    });
});
