import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  saveFile,
  readFile,
  listFiles,
  canSignOut,
  signIn,
  signOut,
  user,
  SaveQueue,
  isNotFound,
  modifiedMs,
  inTrash,
  inAppFolder,
  folderName,
  stat,
  statByUid,
  renameFile,
  pickFile,
  downloadBlob,
  canAI,
  aiChatStream,
  aiChat,
  onWindowClose,
  onLaunch,
} from "../src/cloud.js";

const state = vi.hoisted(() => ({
  files: new Map(),
  readdirError: null,
  picked: null,
  saveTarget: null,
}));

const ai = vi.hoisted(() => ({ events: [], calls: [], chatCalls: [], reply: "" }));

function notFound() {
  return Object.assign(new Error("not found"), { name: "NotFoundError" });
}

vi.mock("@fusion-office/storage", () => ({
  log: () => {},
  writeFile: vi.fn(async (path, blob) => {
    state.files.set(path, blob);
  }),
  readFile: vi.fn(async (path) => {
    const file = state.files.get(path);
    if (!file) throw notFound();
    return file;
  }),
  readdir: vi.fn(async (path) => {
    if (state.readdirError) throw state.readdirError;
    const prefix = `${path.replace(/\/$/, "")}/`;
    return [...state.files]
      .filter(([filePath]) => filePath.startsWith(prefix))
      .map(([filePath, blob]) => ({
        name: filePath.slice(prefix.length),
        path: filePath,
        kind: "file",
        size: blob.size,
        mtime: 0,
      }));
  }),
  stat: vi.fn(async (path) => {
    const blob = state.files.get(path);
    return blob
      ? { kind: "file", name: path.split("/").pop(), size: blob.size, mtime: 0 }
      : null;
  }),
  rename: vi.fn(async (from, to) => {
    state.files.set(to, state.files.get(from));
    state.files.delete(from);
  }),
  deleteFile: vi.fn(async (path) => {
    state.files.delete(path);
  }),
  pickOpenFile: vi.fn(async () => state.picked),
  pickSaveFile: vi.fn(async () => state.saveTarget),
  downloadFallback: vi.fn(),
}));

vi.mock("@fusion-office/ai-client", () => ({
  chatStreamEvents: vi.fn((options) => {
    ai.calls.push(options);
    return (async function* () {
      for (const event of ai.events) yield event;
    })();
  }),
  chat: vi.fn(async (options) => {
    ai.chatCalls.push(options);
    return ai.reply;
  }),
}));

beforeEach(() => {
  state.files.clear();
  state.readdirError = null;
  state.picked = null;
  state.saveTarget = null;
  ai.events = [];
  ai.calls = [];
  ai.chatCalls = [];
  ai.reply = "";
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("local storage boundary", () => {
  it("checks import size before reading bytes while allowing full downloads", async () => {
    const blob = new Blob([new Uint8Array(41 * 1024 * 1024)]);
    const readBytes = vi.spyOn(blob, "arrayBuffer");
    state.files.set("Presentations/large.pptx", blob);
    await expect(
      readFile("Presentations/large.pptx", { importing: true }),
    ).rejects.toThrow("Please choose a PPTX file smaller than 40 MB.");
    expect(readBytes).not.toHaveBeenCalled();
    expect((await readFile("Presentations/large.pptx")).byteLength).toBe(
      blob.size,
    );
    expect(readBytes).toHaveBeenCalledOnce();
  });

  it("stops a read that is already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      readFile("Presentations/a.pptx", { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("writes real PPTX blobs and picks a free name instead of overwriting", async () => {
    const first = await saveFile(new Uint8Array([80, 75]), "Idea");
    expect(first.path).toBe("Presentations/Idea.pptx");
    expect(state.files.get(first.path)).toBeInstanceOf(Blob);
    expect(state.files.get(first.path).type).toBe(
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    );
    const second = await saveFile(new Uint8Array([1]), "Idea");
    expect(second.path).toBe("Presentations/Idea 2.pptx");
    await saveFile(new Uint8Array([1]), "Idea", "Presentations/Idea.pptx");
    expect(
      (await state.files.get("Presentations/Idea.pptx").arrayBuffer())
        .byteLength,
    ).toBe(1);
  });

  it("does not hide permission errors as an empty file list", async () => {
    state.readdirError = { code: "permission_denied" };
    await expect(listFiles()).rejects.toEqual({ code: "permission_denied" });
  });

  it("treats a missing app folder as a new library", async () => {
    state.readdirError = notFound();
    expect(await listFiles()).toEqual([]);
  });

  it("lists only PowerPoint files", async () => {
    state.files.set("Presentations/a.pptx", new Blob(["a"]));
    state.files.set("Presentations/b.txt", new Blob(["b"]));
    expect(await listFiles()).toEqual([
      expect.objectContaining({
        name: "a.pptx",
        path: "Presentations/a.pptx",
        is_dir: false,
      }),
    ]);
  });
});

describe("local session", () => {
  it("is always signed in with a local user and no sign-out", async () => {
    expect(canSignOut()).toBe(false);
    expect((await user()).username).toBe("local");
    expect((await signIn()).username).toBe("local");
    await expect(signOut()).resolves.toBeUndefined();
  });
});

describe("file metadata", () => {
  it("tells a missing file from other failures", () => {
    expect(isNotFound({ code: "subject_does_not_exist" })).toBe(true);
    expect(isNotFound({ error: { code: "subject_does_not_exist" } })).toBe(
      true,
    );
    expect(isNotFound({ name: "NotFoundError" })).toBe(true);
    expect(isNotFound(new Error("No such file or directory"))).toBe(true);
    expect(isNotFound({ code: "permission_denied" })).toBe(false);
    expect(isNotFound(new Error("Network error"))).toBe(false);
  });

  it("reads times in seconds or milliseconds, and knows its folders", () => {
    expect(modifiedMs({ modified: 1_700_000_000 })).toBe(1_700_000_000_000);
    expect(modifiedMs({ modified: "1700000000" })).toBe(1_700_000_000_000);
    expect(modifiedMs({ modified: 1_700_000_000_000 })).toBe(
      1_700_000_000_000,
    );
    expect(modifiedMs({})).toBeNull();
    expect(inTrash("/nj/Trash/abc")).toBe(true);
    expect(inTrash("~/Trash")).toBe(true);
    expect(inTrash("/nj/Desktop/Trash talk.pptx")).toBe(false);
    expect(inAppFolder("/nj/AppData/app/Presentations/Deck.pptx")).toBe(true);
    expect(inAppFolder("Presentations/Deck.pptx")).toBe(true);
    expect(inAppFolder("/nj/Desktop/Deck.pptx")).toBe(false);
    expect(folderName("/nj/Desktop/Deck.pptx")).toBe("Desktop");
  });

  it("describes a saved file and nothing for a missing one", async () => {
    state.files.set("Presentations/Deck.pptx", new Blob(["deck"]));
    expect(await stat("Presentations/Deck.pptx")).toMatchObject({
      path: "Presentations/Deck.pptx",
      name: "Deck.pptx",
      size: 4,
      is_dir: false,
    });
    expect(await stat("Presentations/Gone.pptx")).toBeNull();
    expect(await statByUid("any")).toBeNull();
  });

  it("never renames over another file", async () => {
    state.files.set("Presentations/Old.pptx", new Blob(["a"]));
    state.files.set("Presentations/New.pptx", new Blob(["b"]));
    await expect(renameFile("Presentations/Old.pptx", "New")).rejects.toMatchObject(
      { code: "exists" },
    );
    await renameFile("Presentations/Old.pptx", "Moved");
    expect(state.files.has("Presentations/Moved.pptx")).toBe(true);
    expect(state.files.has("Presentations/Old.pptx")).toBe(false);
  });

  it("renames a file whose name changes case only", async () => {
    state.files.set("Presentations/Deck.pptx", new Blob(["a"]));
    await renameFile("Presentations/Deck.pptx", "deck");
    expect(state.files.has("Presentations/deck.pptx")).toBe(true);
    expect(state.files.has("Presentations/Deck.pptx")).toBe(false);
    expect(
      [...state.files.keys()].filter((path) => /rename-/.test(path)),
    ).toEqual([]);
  });
});

describe("picking files", () => {
  it("imports the chosen file into the app folder", async () => {
    const file = new File([new Uint8Array([1, 2, 3])], "Deck.PPTX");
    state.picked = { kind: "file", file };
    expect(await pickFile()).toMatchObject({
      path: "Presentations/Deck.pptx",
      name: "Deck.pptx",
      size: 3,
    });
    expect(state.files.has("Presentations/Deck.pptx")).toBe(true);
    state.picked = null;
    expect(await pickFile()).toBeNull();
  });
});

describe("downloads", () => {
  it("hands the file to the browser", async () => {
    const click = vi.fn();
    vi.stubGlobal("document", {
      createElement: () => ({ click, remove() {}, set href(v) {}, set download(v) {} }),
      body: { append() {} },
    });
    expect(await downloadBlob(new Blob(["x"]), "Deck.pptx")).toEqual({
      downloaded: true,
    });
    expect(click).toHaveBeenCalledOnce();
  });
});

describe("window hooks", () => {
  it("never takes over a close button it could not release", () => {
    expect(onWindowClose(() => {})).toBe(false);
    expect(onLaunch(() => {})).toBeUndefined();
  });
});

describe("AI through fusion-gateway", () => {
  it("is available and streams text and tool calls", async () => {
    expect(canAI()).toBe(true);
    ai.events = [
      { type: "text", text: "Hi" },
      { type: "tool", id: "t1", name: "read_slide", input: { slide: 2 } },
    ];
    const parts = [];
    for await (const part of aiChatStream([{ role: "user", content: "x" }], {
      model: "m",
      tools: [1],
      maxTokens: 10,
    }))
      parts.push(part);
    expect(ai.calls[0]).toEqual({
      messages: [{ role: "user", content: "x" }],
      model: "m",
      tools: [1],
      maxTokens: 10,
    });
    expect(parts).toEqual([
      { type: "text", text: "Hi" },
      { type: "tool", id: "t1", name: "read_slide", input: { slide: 2 } },
    ]);
  });

  it("sends an image as an OpenAI content part and returns the reply text", async () => {
    ai.reply = "hello";
    const res = await aiChat("read this", "data:image/png;base64,xx", false, {
      model: "m",
    });
    expect(ai.chatCalls[0].messages[0].content).toEqual([
      { type: "text", text: "read this" },
      { type: "image_url", image_url: { url: "data:image/png;base64,xx" } },
    ]);
    expect(ai.chatCalls[0].model).toBe("m");
    expect(res.message.content).toBe("hello");
  });
});

describe("SaveQueue", () => {
  it("serializes writes and recovers after a rejected write", async () => {
    const q = new SaveQueue(),
      order = [];
    let release;
    const first = q.run(async () => {
      order.push(1);
      await new Promise((r) => (release = r));
      throw Error("Offline");
    });
    const rejected = expect(first).rejects.toThrow("Offline");
    const second = q.run(async () => order.push(2));
    await Promise.resolve();
    expect(order).toEqual([1]);
    release();
    await rejected;
    await second;
    expect(order).toEqual([1, 2]);
  });
});
