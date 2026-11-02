import { describe, expect, it } from "vitest";
import { parseHomePrompt } from "../src/start/deeplink.js";

describe("parseHomePrompt", () => {
  it("returns null for plain routes and #/home without a prompt", () => {
    expect(parseHomePrompt("#/home")).toBeNull();
    expect(parseHomePrompt("#/home?source=fusion-design")).toBeNull();
    expect(parseHomePrompt("")).toBeNull();
    expect(parseHomePrompt("#/new")).toBeNull();
  });

  it("reads the prompt and source from a deep link", () => {
    const parsed = parseHomePrompt(
      "#/home?prompt=Deck%20about%20tides&source=fusion-design",
    );
    expect(parsed).toEqual({
      prompt: "Deck about tides",
      source: "fusion-design",
    });
  });

  it("truncates a prompt past the textarea cap and a long source", () => {
    const parsed = parseHomePrompt(
      `#/home?prompt=${"x".repeat(5000)}&source=${"s".repeat(300)}`,
    );
    expect(parsed.prompt).toBe("x".repeat(4000));
    expect(parsed.source).toBe("s".repeat(200));
  });
});
