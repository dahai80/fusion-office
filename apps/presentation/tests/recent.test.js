import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  recentFiles,
  rememberRecent,
  forgetRecent,
  moveRecent,
  refreshRecent,
} from "../src/recent.js";

const lookup = vi.hoisted(() => ({ found: new Map(), failing: new Set() }));

vi.mock("@fusion-office/storage", () => ({
  log: () => {},
  stat: vi.fn(async (path) => {
    if (lookup.failing.has(path)) throw new Error("Network error");
    return lookup.found.get(path) || null;
  }),
}));

beforeEach(() => {
  lookup.found.clear();
  lookup.failing.clear();
  const store = new Map();
  vi.stubGlobal("localStorage", {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("presentations opened from elsewhere on the drive", () => {
  it("are kept per account, newest first, without the app's own folder or the trash", () => {
    rememberRecent("a", { path: "/a/Desktop/One.pptx", uid: "1" });
    rememberRecent("a", { path: "/a/Docs/Two.pptx", uid: "2" });
    rememberRecent("a", { path: "/a/AppData/x/Presentations/Three.pptx" });
    rememberRecent("a", { path: "/a/Trash/4" });
    rememberRecent("b", { path: "/b/Desktop/Other.pptx" });
    expect(recentFiles("a").map((r) => r.name)).toEqual([
      "Two.pptx",
      "One.pptx",
    ]);
    // Opening one again moves it to the front, once.
    rememberRecent("a", { path: "/a/Desktop/One.pptx", uid: "1" });
    expect(recentFiles("a").map((r) => r.name)).toEqual([
      "One.pptx",
      "Two.pptx",
    ]);
    forgetRecent("a", "/a/Desktop/One.pptx");
    expect(recentFiles("a").map((r) => r.name)).toEqual(["Two.pptx"]);
    expect(recentFiles("b")).toHaveLength(1);
  });
  it("follow a rename made here", () => {
    rememberRecent("a", { path: "/a/Desktop/One.pptx", uid: "1" });
    moveRecent("a", "/a/Desktop/One.pptx", "/a/Desktop/Uno.pptx", "Uno.pptx");
    expect(recentFiles("a")).toMatchObject([
      { path: "/a/Desktop/Uno.pptx", name: "Uno.pptx", uid: "1" },
    ]);
  });
  it("keep the ones still on disk, refresh their time, and drop the ones gone", async () => {
    rememberRecent("a", { path: "/a/Desktop/Keep.pptx", uid: "keep" });
    rememberRecent("a", { path: "/a/Desktop/Gone.pptx", uid: "gone" });
    rememberRecent("a", { path: "/a/Desktop/Flaky.pptx", uid: "flaky" });
    lookup.found.set("/a/Desktop/Keep.pptx", {
      path: "/a/Desktop/Keep.pptx",
      name: "Keep.pptx",
      size: 1,
      mtime: 5,
    });
    lookup.failing.add("/a/Desktop/Flaky.pptx");
    expect(await refreshRecent("a")).toMatchObject([
      { path: "/a/Desktop/Flaky.pptx" },
      { path: "/a/Desktop/Keep.pptx", modified: 5 },
    ]);
  });
  it("are left as they are where files cannot be looked up", async () => {
    rememberRecent("a", { path: "/a/Desktop/One.pptx", uid: "1" });
    lookup.failing.add("/a/Desktop/One.pptx");
    expect(await refreshRecent("a")).toHaveLength(1);
  });
});
