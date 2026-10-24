// Every assistant tool, driven through the real GUI: the panel sends the
// message, the mocked gateway answers with one tool call, and the test reads
// the change off the editor itself. No model is loaded.
import { test, expect } from "@playwright/test";
import { installGatewayMock } from "./gateway-mock.js";
import { addText, inspector, themeDialog } from "./editor-commands.js";

const PUTER = (() => {
  const stub =
    'window.puter={env:"web",auth:{isSignedIn:async()=>false},ui:{onLaunchedWithItems:()=>{}}};';
  return { contentType: "application/javascript", body: stub };
})();

const desktopOnly = (info) =>
  test.skip(info.project.name !== "desktop", "One layout covers the flow");

function trackErrors(page) {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

async function start(page) {
  await page.addInitScript(() =>
    localStorage.removeItem("presentation:assistant"),
  );
  await page.route("/puter-sdk.js", (route) => route.fulfill(PUTER));
  const gateway = installGatewayMock(page);
  await gateway.install();
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "Present", exact: true }),
  ).toBeVisible();
  return gateway;
}

async function openAssistant(page) {
  await page.getByRole("button", { name: "Ask AI" }).click();
  const panel = page.locator("#ai-panel");
  await expect(panel).toBeVisible();
  return panel;
}

// Sends one message and waits for its reply to finish, answering the
// approval question that a deleting tool asks before it runs.
async function ask(page, panel, prompt, { allow = false } = {}) {
  const replies = panel.locator(".ai-msg.ai-assistant");
  const before = await replies.count();
  const box = page.getByRole("textbox", { name: "Message the assistant" });
  await box.fill(prompt);
  await box.press("Enter");
  await expect(replies).toHaveCount(before + 1);
  if (allow) {
    const card = panel.getByRole("group", { name: "Allow this change?" });
    await expect(card).toBeVisible();
    await card.getByRole("button", { name: "Allow", exact: true }).click();
  }
  await expect(replies.last()).not.toHaveAttribute("aria-busy", "true");
}

const done = (panel, text) =>
  expect(
    panel.locator(".ai-step-done").filter({ hasText: text }).first(),
  ).toBeVisible();

const shapeId = async (locator) =>
  Number(await locator.getAttribute("data-shape-id"));

test("the read tools inspect the deck and select points at an object", async ({
  page,
}, info) => {
  desktopOnly(info);
  const errors = trackErrors(page);
  const gateway = await start(page);
  // Something with text for find_text to find, made the way a person does.
  await addText(page);
  await page.keyboard.press("Escape");
  const object = page.locator(".object-hit").first();
  await expect(object).toBeVisible();
  const id = await shapeId(object);
  const panel = await openAssistant(page);

  gateway.reply([{ name: "get_presentation", args: {} }], "Looked it over.");
  await ask(page, panel, "What is in this deck?");
  await done(panel, "Look over the presentation");

  gateway.reply([{ name: "read_slide", args: { slide: 1 } }], "Read it.");
  await ask(page, panel, "Read slide 1 to me.");
  await done(panel, "Read slide 1");

  gateway.reply(
    [{ name: "find_text", args: { query: "Your text" } }],
    "Found it.",
  );
  await ask(page, panel, "Where does it say Your text?");
  await done(panel, "Search for");

  gateway.reply(
    [{ name: "select", args: { slide: 1, ids: [id] } }],
    "Pointed at it.",
  );
  await ask(page, panel, "Point at that text box.");
  await done(panel, "Show slide 1");
  const selected = page.locator(".object-hit.selected");
  await expect(selected).toHaveCount(1);
  await expect(selected).toHaveAttribute("data-shape-id", String(id));
  await expect(selected).toHaveAttribute("aria-pressed", "true");

  // The deck and its tools travelled with the message, and every call was
  // answered by the id it was given.
  expect(gateway.requests[0].tools.length).toBeGreaterThan(20);
  expect(gateway.requests[0].messages[1].content).toContain(
    "<presentation_state>",
  );
  const answered = gateway.requests.filter(
    (body) => body.messages.at(-1).role === "tool",
  );
  expect(answered).toHaveLength(4);
  for (const body of answered) {
    expect(body.messages.at(-1).tool_call_id).toMatch(/^call_gateway_/);
  }
  expect(errors).toEqual([]);
});

test("the slide tools add, copy, move, delete and hide slides", async ({
  page,
}, info) => {
  desktopOnly(info);
  const errors = trackErrors(page);
  const gateway = await start(page);
  const panel = await openAssistant(page);
  const slides = page.locator("#slide-list .slide-item");

  gateway.reply(
    [
      {
        name: "add_slide",
        args: { layout: "content", title: "Roadmap", body: "Q1 launch" },
      },
    ],
    "Added it.",
  );
  await ask(page, panel, "Add a roadmap slide.");
  await done(panel, "Add a content slide");
  await expect(slides).toHaveCount(2);
  await expect(page.locator("#slide-canvas .slide-image")).toHaveAttribute(
    "alt",
    /Roadmap/,
  );

  gateway.reply([{ name: "duplicate_slide", args: { slide: 2 } }], "Copied.");
  await ask(page, panel, "Copy the roadmap slide.");
  await done(panel, "Copy slide 2");
  await expect(slides).toHaveCount(3);
  await expect(page.locator("#slide-position")).toHaveText("Slide 3 of 3");
  await expect(page.locator("#slide-canvas .slide-image")).toHaveAttribute(
    "alt",
    /Roadmap/,
  );

  gateway.reply(
    [{ name: "move_slide", args: { slide: 1, to: 3 } }],
    "Moved it.",
  );
  await ask(page, panel, "Move the first slide to the end.");
  await done(panel, "Move slide 1 to position 3");
  await expect(page.locator("#slide-position")).toHaveText("Slide 3 of 3");
  await expect(slides.nth(2)).toHaveClass(/active/);
  await expect(page.locator("#slide-canvas .slide-image")).toHaveAttribute(
    "alt",
    /^Slide 3: Blank slide/,
  );

  gateway.reply(
    [{ name: "delete_slides", args: { slides: [3] } }],
    "Deleted it.",
  );
  await ask(page, panel, "Delete the blank slide.", { allow: true });
  await done(panel, "Delete slide 3");
  await expect(slides).toHaveCount(2);

  gateway.reply(
    [{ name: "set_slide_properties", args: { slides: [1], hidden: true } }],
    "Hidden.",
  );
  await ask(page, panel, "Hide the first slide.");
  await done(panel, "Change slide 1: hide");
  await expect(
    page.locator("#slide-list .slide-item.hidden-slide"),
  ).toHaveCount(1);
  expect(errors).toEqual([]);
});

test("the text tools write notes, add text, rewrite it and replace it", async ({
  page,
}, info) => {
  desktopOnly(info);
  const errors = trackErrors(page);
  const gateway = await start(page);
  const panel = await openAssistant(page);

  gateway.reply(
    [{ name: "set_notes", args: { notes: "Welcome everyone" } }],
    "Notes written.",
  );
  await ask(page, panel, "Write speaker notes.");
  await done(panel, "Write speaker notes for slide 1");
  await expect(page.locator("#speaker-notes")).toHaveValue("Welcome everyone");

  gateway.reply(
    [
      {
        name: "add_text",
        args: { text: "Hello deck", x: 1, y: 1, w: 6, h: 1 },
      },
    ],
    "Added it.",
  );
  await ask(page, panel, "Add a greeting to the slide.");
  await done(panel, "Add text");
  const object = page.locator('.object-hit[aria-label^="Hello deck"]');
  await expect(object).toHaveCount(1);
  const id = await shapeId(object);

  gateway.reply(
    [{ name: "set_text", args: { slide: 1, id, text: "Goodbye deck" } }],
    "Rewrote it.",
  );
  await ask(page, panel, "Change the greeting to Goodbye deck.");
  await done(panel, "Rewrite");
  await expect(
    page.locator('.object-hit[aria-label^="Goodbye deck"]'),
  ).toHaveCount(1);
  await expect(object).toHaveCount(0);

  gateway.reply(
    [{ name: "replace_text", args: { find: "Goodbye", replace: "Farewell" } }],
    "Replaced it.",
  );
  await ask(page, panel, "Replace Goodbye with Farewell.");
  await done(panel, "Replace");
  const replaced = page.locator('.object-hit[aria-label^="Farewell deck"]');
  await expect(replaced).toHaveCount(1);
  await expect(
    page.locator('.object-hit[aria-label^="Goodbye deck"]'),
  ).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("the object tools add shapes, lines and tables, edit cells and delete", async ({
  page,
}, info) => {
  desktopOnly(info);
  const errors = trackErrors(page);
  const gateway = await start(page);
  const panel = await openAssistant(page);
  const hits = page.locator(".object-hit");

  gateway.reply(
    [
      {
        name: "add_shape",
        args: {
          shape: "ellipse",
          x: 1,
          y: 1,
          w: 2,
          h: 2,
          text: "Orbit",
        },
      },
    ],
    "Added a circle.",
  );
  await ask(page, panel, "Add an orbit circle.");
  await done(panel, "Add a circle to slide 1");
  await expect(hits).toHaveCount(1);
  await expect(page.locator('.object-hit[aria-label^="Orbit"]')).toHaveCount(1);

  gateway.reply(
    [
      {
        name: "add_line",
        args: { x1: 1, y1: 4, x2: 6, y2: 4, arrow: true, width: 4 },
      },
    ],
    "Added an arrow.",
  );
  await ask(page, panel, "Draw an arrow under the circle.");
  await done(panel, "Add an arrow to slide 1");
  await expect(hits).toHaveCount(2);
  const arrow = page.locator('.object-hit[aria-label^="Arrow"]');
  await expect(arrow).toHaveCount(1);
  const arrowId = await shapeId(arrow);

  gateway.reply(
    [
      {
        name: "add_table",
        args: {
          rows: [
            ["Quarter", "Revenue"],
            ["Q1", "100"],
          ],
          x: 1,
          y: 5,
          w: 6,
        },
      },
    ],
    "Added a table.",
  );
  await ask(page, panel, "Add a revenue table.");
  await done(panel, "Add a 2×2 table to slide 1");
  await expect(hits).toHaveCount(3);
  const canvas = page.locator("#slide-canvas .slide-image");
  await expect(canvas).toHaveAttribute("alt", /Quarter/);
  await expect(canvas).toHaveAttribute("alt", /Revenue/);
  const tableId = await shapeId(hits.last());

  gateway.reply(
    [
      {
        name: "set_table_cells",
        args: { id: tableId, cells: [{ row: 2, col: 2, text: "250" }] },
      },
    ],
    "Wrote the cell.",
  );
  await ask(page, panel, "Set Q1 revenue to 250.");
  await done(panel, "Edit table cells on slide 1");
  await expect(canvas).toHaveAttribute("alt", /250/);
  await expect(canvas).not.toHaveAttribute("alt", /100/);

  gateway.reply(
    [{ name: "delete_objects", args: { slide: 1, ids: [arrowId] } }],
    "Deleted the arrow.",
  );
  await ask(page, panel, "Delete the arrow.", { allow: true });
  await done(panel, "Delete 1 object from slide 1");
  await expect(arrow).toHaveCount(0);
  await expect(hits).toHaveCount(2);
  expect(errors).toEqual([]);
});

test("the layout and style tools move, reorder, format, recolor and restyle", async ({
  page,
}, info) => {
  desktopOnly(info);
  const errors = trackErrors(page);
  const gateway = await start(page);
  const panel = await openAssistant(page);

  gateway.reply(
    [
      {
        name: "add_shape",
        args: { shape: "rect", x: 1, y: 1, w: 2, h: 1.5, text: "Alpha" },
      },
    ],
    "Added Alpha.",
  );
  await ask(page, panel, "Add a box labelled Alpha.");
  await done(panel, "Add a rectangle to slide 1");
  const alpha = page.locator('.object-hit[aria-label^="Alpha"]');
  await expect(alpha).toHaveCount(1);
  const alphaId = await shapeId(alpha);
  const alphaHit = page.locator(`.object-hit[data-shape-id="${alphaId}"]`);

  gateway.reply(
    [
      {
        name: "add_shape",
        args: { shape: "rect", x: 5, y: 1, w: 2, h: 1.5, text: "Beta" },
      },
    ],
    "Added Beta.",
  );
  await ask(page, panel, "Add a box labelled Beta.");
  await done(panel, "Add a rectangle to slide 1");
  const beta = page.locator('.object-hit[aria-label^="Beta"]');
  await expect(beta).toHaveCount(1);
  const betaId = await shapeId(beta);

  const box = () =>
    alphaHit.evaluate((node) => ({
      left: parseFloat(node.style.left),
      top: parseFloat(node.style.top),
      width: parseFloat(node.style.width),
      height: parseFloat(node.style.height),
    }));
  const before = await box();

  gateway.reply(
    [
      {
        name: "set_bounds",
        args: {
          slide: 1,
          items: [{ id: alphaId, x: 3, y: 4, w: 3, h: 1.5 }],
        },
      },
    ],
    "Moved it.",
  );
  await ask(page, panel, "Move Alpha to the lower middle and make it wider.");
  await done(panel, "Arrange 1 object on slide 1");
  const after = await box();
  expect(after).not.toEqual(before);
  // 3 in of 13.333 and 4 in of 7.5, as percentages of the slide.
  expect(Math.abs(after.left - 22.5)).toBeLessThan(0.3);
  expect(Math.abs(after.top - 53.33)).toBeLessThan(0.3);
  expect(Math.abs(after.width - 22.5)).toBeLessThan(0.3);

  gateway.reply(
    [{ name: "reorder_objects", args: { ids: [alphaId], to: "front" } }],
    "Brought it forward.",
  );
  await ask(page, panel, "Bring Alpha to the front.");
  await done(panel, "Reorder 1 object on slide 1");
  const order = await page
    .locator(".object-hit")
    .evaluateAll((nodes) => nodes.map((node) => Number(node.dataset.shapeId)));
  expect(order).toEqual([betaId, alphaId]);

  gateway.reply(
    [
      {
        name: "format_text",
        args: {
          ids: [alphaId],
          bold: true,
          size: 36,
          color: "#C00000",
        },
      },
    ],
    "Formatted it.",
  );
  await ask(page, panel, "Make Alpha bold and 36 point.");
  await done(panel, "Format text of 1 object on slide 1");
  await page.locator(`.object-hit[data-shape-id="${alphaId}"]`).click();
  await page.getByRole("tab", { name: "Home", exact: true }).click();
  const control = (id) =>
    page
      .locator(
        `.ribbon-panel [data-command="${id}"], .ribbon-fold-panel [data-command="${id}"]`,
      )
      .first();
  await expect(control("bold")).toHaveAttribute("aria-pressed", "true");
  await expect(control("font-size")).toHaveValue("36");

  gateway.reply(
    [{ name: "apply_theme", args: { theme: "cobalt" } }],
    "Recolored the deck.",
  );
  await ask(page, panel, "Recolor the deck to Cobalt.");
  await done(panel, "Apply the Cobalt palette");
  await themeDialog(page);
  await expect(page.locator(".theme-choice[aria-pressed=true]")).toContainText(
    "Cobalt",
  );
  await page.keyboard.press("Escape");

  gateway.reply(
    [
      {
        name: "style_objects",
        args: {
          ids: [alphaId],
          fill: "#00CC66",
          outline_color: "#112233",
          outline_width: 3,
        },
      },
    ],
    "Restyled it.",
  );
  await ask(page, panel, "Give Alpha a green fill and a dark border.");
  await done(panel, "Restyle 1 object on slide 1");
  await inspector(page);
  await expect(
    page.locator('input[aria-label="Fill color"]').first(),
  ).toHaveValue("#00cc66");
  await expect(
    page.locator('input[aria-label="Border color"]').first(),
  ).toHaveValue("#112233");
  expect(errors).toEqual([]);
});
