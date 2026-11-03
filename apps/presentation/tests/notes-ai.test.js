import { describe, it, expect, vi, beforeEach } from "vitest";
import { P, createDeck, slideDescription } from "../src/model.js";
import {
  slideSourceText,
  notesFromReply,
  buildBatches,
  createNotesAI,
} from "../src/notes-ai.js";

const ai = vi.hoisted(() => ({ available: true, replies: [], calls: [] }));

vi.mock("../src/review/ai.js", () => ({
  aiAvailable: () => ai.available,
  askJson: async (...args) => {
    ai.calls.push(args);
    const reply = ai.replies.shift();
    if (reply instanceof Error) throw reply;
    return reply;
  },
}));

const FILLER = "Packaging waste is a problem. ".repeat(70); // ~2030 chars

// A deck of n slides, each carrying a long, distinctive text box.
function longDeck(n) {
  const pres = createDeck("blank");
  let slides = P.getSlides(pres);
  while (slides.length < n) {
    P.duplicateSlide(pres, slides[slides.length - 1]);
    slides = P.getSlides(pres);
  }
  // Duplicating replaces the slide objects: fetch them fresh before editing.
  slides = P.getSlides(pres);
  slides.forEach((slide, i) => {
    P.addSlideTextBox(slide, {
      x: 914400,
      y: 914400,
      w: 5486400,
      h: 914400,
      text: `Slide ${i + 1} body ${FILLER}`,
    });
  });
  return { pres, slides };
}

function controllerFor(pres, { current = 0 } = {}) {
  const slides = () => P.getSlides(pres);
  const writes = [];
  const controller = createNotesAI({
    all: slides,
    current: () => slides()[current],
    number: (s) => slides().indexOf(s) + 1,
    description: (s) => slideDescription(s, pres),
    write: async (slide, value) => {
      writes.push([slides().indexOf(slide) + 1, value]);
      P.setSlideNotes(slide, value);
    },
  });
  return { controller, writes };
}

const payloadOf = (call) => JSON.parse(call[1].split("\n")[1]);
const payloadLength = (items) =>
  JSON.stringify(items.map(({ slide, text }) => ({ slide, text }))).length;

beforeEach(() => {
  ai.available = true;
  ai.replies = [];
  ai.calls = [];
});

describe("the slide text and the reply", () => {
  it("caps a slide's text at the per-slide cap", () => {
    expect(slideSourceText("  hi  ")).toBe("hi");
    expect(slideSourceText("x".repeat(2500))).toHaveLength(2000);
  });
  it("keeps the notes entries from a reply, in order", () => {
    expect(notesFromReply({ notes: [" A. ", "", 3, "B."] })).toEqual([
      "A.",
      "B.",
    ]);
    expect(notesFromReply({ notes: "Only one." })).toEqual(["Only one."]);
    expect(notesFromReply({})).toEqual([]);
  });
});

describe("batching", () => {
  it("packs slides into bounded batches that cover every slide once", () => {
    const items = Array.from({ length: 8 }, (_, i) => ({
      number: i + 1,
      text: "x".repeat(2000),
    }));
    const batches = buildBatches(items);
    // Never one giant call.
    expect(batches.length).toBeGreaterThan(1);
    expect(batches.flatMap((b) => b.map((i) => i.number))).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8,
    ]);
    for (const batch of batches)
      expect(
        payloadLength(batch.map(({ number, text }) => ({ slide: number, text }))),
      ).toBeLessThanOrEqual(8000);
  });
});

describe("per-slide generation", () => {
  it("fills the current slide's notes through the write path", async () => {
    const { pres, slides } = longDeck(1);
    const { controller, writes } = controllerFor(pres);
    ai.replies = [
      { notes: ["Welcome everyone. Here is the plan in three steps."] },
    ];
    await controller.run("slide");
    expect(writes).toEqual([
      [1, "Welcome everyone. Here is the plan in three steps."],
    ]);
    expect(P.getSlideNotes(slides[0])).toBe(
      "Welcome everyone. Here is the plan in three steps.",
    );
    expect(controller.state.error).toBe(false);
    const [system, user] = ai.calls[0];
    expect(system).toMatch(/speaker notes/);
    expect(user).toMatch(/Slide 1 body/);
  });
  it("says so when the slide has no text to write from", async () => {
    const pres = createDeck("blank");
    const { controller, writes } = controllerFor(pres);
    await controller.run("slide");
    expect(ai.calls).toHaveLength(0);
    expect(writes).toEqual([]);
    expect(controller.state.error).toBe(true);
    expect(controller.state.message).toMatch(/no text/);
  });
});

describe("all-slides generation", () => {
  it("writes every slide in bounded batches, not one giant call", async () => {
    const n = 8;
    const { pres, slides } = longDeck(n);
    const items = slides.map((slide, i) => ({
      number: i + 1,
      text: slideSourceText(slideDescription(slide, pres)),
    }));
    const expected = buildBatches(items);
    expect(expected.length).toBeGreaterThan(1);
    ai.replies = expected.map((batch) => ({
      notes: batch.map((i) => `Notes for slide ${i.number}`),
    }));
    const { controller, writes } = controllerFor(pres);
    await controller.run("all");
    expect(ai.calls).toHaveLength(expected.length);
    for (const call of ai.calls)
      expect(JSON.stringify(payloadOf(call))).toMatch(
        new RegExp(`"text":"Slide [1-${n}] body`),
      );
    expect(writes).toHaveLength(n);
    expect(writes.map(([number]) => number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    for (const [number, value] of writes)
      expect(value).toBe(`Notes for slide ${number}`);
    for (const slide of slides)
      expect(P.getSlideNotes(slide)).toMatch(/Notes for slide/);
    expect(controller.state.error).toBe(false);
    expect(controller.state.message).toMatch(/8 slides/);
  });
});

describe("when the gateway fails", () => {
  it("shows an inline message and writes nothing for one slide", async () => {
    const { pres } = longDeck(1);
    const { controller, writes } = controllerFor(pres);
    ai.replies = [new Error("gateway down")];
    await controller.run("slide");
    expect(writes).toEqual([]);
    expect(controller.state.error).toBe(true);
    expect(controller.state.message).toMatch(/gateway down/);
  });
  it("reports how far an all-slides run got before stopping", async () => {
    const { pres } = longDeck(8);
    const { controller, writes } = controllerFor(pres);
    const items = P.getSlides(pres).map((slide, i) => ({
      number: i + 1,
      text: slideSourceText(slideDescription(slide, pres)),
    }));
    const batches = buildBatches(items);
    ai.replies = [
      { notes: batches[0].map((i) => `Notes for slide ${i.number}`) },
      new Error("gateway down"),
    ];
    await controller.run("all");
    expect(writes.map(([number]) => number)).toEqual(
      batches[0].map((i) => i.number),
    );
    expect(controller.state.error).toBe(true);
    expect(controller.state.message).toMatch(/gateway down/);
    expect(controller.state.message).toMatch(
      new RegExp(`Wrote ${batches[0].length} of 8`),
    );
  });
  it("stays silent-proof when the AI service is not configured", async () => {
    ai.available = false;
    const { pres } = longDeck(1);
    const { controller, writes } = controllerFor(pres);
    await controller.run("slide");
    expect(ai.calls).toHaveLength(0);
    expect(writes).toEqual([]);
    expect(controller.state.error).toBe(true);
    expect(controller.state.message).toMatch(/not available/);
  });
});
