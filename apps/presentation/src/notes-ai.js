// One-shot speaker-notes generation: a slide's text goes to the AI and the
// spoken-style notes it returns are written through the notes' usual edit
// path (the same mutation the assistant's set_notes tool and the notes box
// use), so undo and history stay consistent. Hosted beside the speaker-notes
// box in the editor.
import { el, icon } from "./ui.js";
import { aiAvailable, askJson } from "./review/ai.js";

// A slide sends at most this many characters of its text to the AI.
const SLIDE_TEXT_CAP = 2000;
// A batch of slides sends at most this many characters of payload in all.
const BATCH_TEXT_CAP = 8000;

const SYSTEM =
  "You write speaker notes for presentation slides. Answer only with JSON of the form " +
  '{"notes": string[]} with one entry per input slide, in order. ' +
  "Each entry holds 2 to 4 short spoken-style sentences the presenter can read aloud, written in the same language as the slide's own text. Do not add explanations.";

// The text the notes are written from: the slide's description, capped.
export function slideSourceText(description, cap = SLIDE_TEXT_CAP) {
  const text = String(description || "").trim();
  return text.length > cap ? text.slice(0, cap) : text;
}

// The notes from an answer: one trimmed string per slide, in order.
export function notesFromReply(data) {
  const value = data?.notes;
  const list = Array.isArray(value) ? value : [value];
  return list
    .filter((t) => typeof t === "string" && t.trim())
    .map((t) => t.trim());
}

// Slides travel to the AI in batches whose combined payload stays within the
// cap; a slide too large for the batch it would join starts the next one.
export function buildBatches(items, cap = BATCH_TEXT_CAP) {
  const weight = (item) =>
    JSON.stringify({ slide: item.number, text: item.text }).length;
  const batches = [];
  let batch = [];
  let size = 0;
  for (const item of items) {
    const w = weight(item);
    if (batch.length && size + w > cap) {
      batches.push(batch);
      batch = [];
      size = 0;
    }
    batch.push(item);
    size += w;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

export function createNotesAI(deps) {
  const state = { busy: false, message: "", error: false };
  let parts = null;

  function say(message, error = false) {
    state.message = message || "";
    state.error = error;
    if (parts) {
      parts.status.textContent = state.message;
      parts.status.dataset.kind = error ? "error" : "";
    }
  }

  function setBusy(busy) {
    state.busy = busy;
    for (const b of parts?.buttons || []) b.disabled = busy || null;
  }

  // The slides to write for: the current one, or every slide with text.
  function targets(kind) {
    const list = kind === "all" ? deps.all() : [deps.current()].filter(Boolean);
    const items = list.map((slide, i) => ({
      slide,
      number: kind === "all" ? i + 1 : deps.number(slide),
      text: slideSourceText(deps.description(slide)),
    }));
    return {
      items: items.filter((i) => i.text),
      skipped: items.length - items.filter((i) => i.text).length,
    };
  }

  async function run(kind) {
    if (state.busy) return;
    if (!aiAvailable()) {
      say(
        "Writing notes needs the local AI service, which is not available here.",
        true,
      );
      return;
    }
    const { items, skipped } = targets(kind);
    if (!items.length) {
      say(
        kind === "all"
          ? "None of the slides has text to write notes from."
          : "This slide has no text to write notes from.",
        true,
      );
      return;
    }
    const every = kind === "all";
    // Every slide written in one run shares an undo step, as far as the
    // edits stay inside the coalescing window.
    const coalesce = every ? "notes-ai" : null;
    setBusy(true);
    say(every ? "Writing notes for the deck…" : "Writing notes…");
    let done = 0;
    try {
      for (const batch of buildBatches(items)) {
        const payload = batch.map((i) => ({ slide: i.number, text: i.text }));
        const reply = await askJson(
          SYSTEM,
          `Write speaker notes for these slides.\n${JSON.stringify(payload)}`,
          { maxTokens: 4000 },
        );
        const notes = notesFromReply(reply);
        if (notes.length !== batch.length)
          throw new Error("The notes came back incomplete. Try again.");
        for (let i = 0; i < batch.length; i++)
          await deps.write(batch[i].slide, notes[i], coalesce);
        done += batch.length;
        if (every && done < items.length)
          say(`Wrote notes for ${done} of ${items.length} slides…`);
      }
      say(
        `Wrote notes for ${done} slide${done === 1 ? "" : "s"}${
          skipped ? `; skipped ${skipped} without text` : ""
        }.`,
      );
    } catch (e) {
      console.error("Writing speaker notes failed:", e);
      const reason = e?.message || "Writing the notes failed.";
      say(
        done
          ? `${reason} Wrote ${done} of ${items.length} slides before stopping.`
          : reason,
        true,
      );
    } finally {
      setBusy(false);
    }
  }

  // The control beside the speaker-notes box. Rebuilt with the editor, so it
  // carries the latest state each time it is drawn.
  function bar() {
    const available = aiAvailable();
    const run_ = (kind) => () => run(kind);
    const generate = el(
      "button",
      {
        type: "button",
        class: "btn secondary notes-ai-run",
        title: "Write speaker notes for this slide with the local AI",
        disabled: state.busy || !available || null,
        onclick: run_("slide"),
      },
      icon("Sparkles", 14),
      el("span", {}, "Generate with AI"),
    );
    const all = el(
      "button",
      {
        type: "button",
        class: "btn secondary notes-ai-run-all",
        title: "Write speaker notes for every slide with the local AI",
        disabled: state.busy || !available || null,
        onclick: run_("all"),
      },
      icon("Sparkles", 14),
      el("span", {}, "All slides"),
    );
    const status = el(
      "span",
      { class: "notes-ai-status", role: "status" },
      state.message,
    );
    status.dataset.kind = state.error ? "error" : "";
    parts = { status, buttons: [generate, all] };
    const wrap = el("div", { class: "notes-ai-bar" }, generate, all, status);
    if (!available)
      wrap.append(
        el("span", { class: "notes-ai-hint" }, "Needs the local AI service."),
      );
    return wrap;
  }

  return { bar, run, state };
}
