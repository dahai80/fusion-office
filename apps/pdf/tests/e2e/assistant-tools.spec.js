import { test, expect } from '@playwright/test';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { mockGateway } from './gateway-mock.js';

test.skip(({ isMobile }) => isMobile, 'The AI sidebar is a desktop layout.');

const PUTER_MOCK = `window.puter = { env: 'web', auth: { isSignedIn: () => true, getUser: async () => ({username:'test-user'}), signIn: async () => {}, signOut: async () => {} }, fs: { readdir: async () => [], write: async () => ({}) }, ui: { onLaunchedWithItems: () => {}, onItemsOpened: () => {} } };`;

const ALL_TOOLS = [
    'get_document_info',
    'read_pages',
    'find_text',
    'go_to_page',
    'set_zoom',
    'add_bookmark',
];

async function mockPuter(page) {
    await page.route('**/puter-sdk.js', (route) =>
        route.fulfill({ contentType: 'application/javascript', body: PUTER_MOCK }),
    );
}

async function samplePdf() {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const lines = [
        'Hello world from page one',
        'Second page has no greeting',
        'Hello again on page three',
        'Fourth page closes it',
    ];
    for (const line of lines) {
        const sheet = doc.addPage([420, 560]);
        sheet.drawText(line, { x: 40, y: 500, size: 16, font });
    }
    return doc;
}

async function openPdf(page) {
    const doc = await samplePdf();
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: /Open a PDF/ }).click();
    await (await chooser).setFiles({
        name: 'assistant.pdf',
        mimeType: 'application/pdf',
        buffer: Buffer.from(await doc.save()),
    });
    await expect(page.locator('.page-caption')).toHaveText('Page 1 of 4');
}

async function openAssistant(page) {
    if (!(await page.locator('#page-sidebar').isVisible()))
        await page.getByRole('button', { name: 'Toggle pages panel', exact: true }).click();
    await page.getByRole('tab', { name: 'Ask AI', exact: true }).click();
    await expect(page.locator('.ai-question')).toBeVisible();
}

async function start(page) {
    await mockPuter(page);
    await page.goto('/#library');
    await openPdf(page);
    await openAssistant(page);
}

async function ask(page, text) {
    await page.locator('.ai-question').fill(text);
    await page.getByRole('button', { name: 'Ask', exact: true }).click();
}

function watchErrors(page) {
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    return errors;
}

async function expectStep(page, label) {
    const step = page.locator('.ai-step').first();
    await expect(step).toBeVisible();
    await expect(step.locator('.ai-step-label')).toHaveText(label);
    await expect(step).toHaveAttribute('data-status', 'done');
}

async function expectAnswer(page, text) {
    await expect(page.locator('.ai-answer')).toBeVisible();
    await expect(page.locator('.ai-answer-text')).toHaveText(text);
}

test('get_document_info reads the open document details', async ({ page }) => {
    const errors = watchErrors(page);
    const requests = await mockGateway(page, {
        tool: 'get_document_info',
        args: {},
        answer: 'This PDF has 4 pages.',
    });
    await start(page);
    await ask(page, 'What am I looking at?');
    await expectStep(page, 'Read the document details');
    await expectAnswer(page, 'This PDF has 4 pages.');
    expect(requests).toHaveLength(2);
    expect(requests[0].tools.map((tool) => tool.function.name)).toEqual(
        expect.arrayContaining(ALL_TOOLS),
    );
    await expect(page.locator('.ai-question')).toBeEnabled();
    expect(errors).toEqual([]);
});

test('read_pages returns the real page text to the model', async ({ page }) => {
    const errors = watchErrors(page);
    const requests = await mockGateway(page, {
        tool: 'read_pages',
        args: { from: 1, count: 2 },
        answer: 'Page 1 greets the reader.',
    });
    await start(page);
    await ask(page, 'Read the first two pages.');
    await expectStep(page, 'Read pages 1 to 2');
    await expectAnswer(page, 'Page 1 greets the reader.');
    const result = requests[1].messages.at(-1);
    expect(result.role).toBe('tool');
    expect(result.content).toContain('[Page 1] Hello world from page one');
    expect(result.content).toContain('[Page 2] Second page has no greeting');
    expect(errors).toEqual([]);
});

test('find_text locates the pages that hold the words', async ({ page }) => {
    const errors = watchErrors(page);
    const requests = await mockGateway(page, {
        tool: 'find_text',
        args: { query: 'Hello' },
        answer: 'Hello is on pages 1 and 3.',
    });
    await start(page);
    await ask(page, 'Which pages mention Hello?');
    await expectStep(page, 'Find "Hello"');
    await expectAnswer(page, 'Hello is on pages 1 and 3.');
    const result = requests[1].messages.at(-1);
    expect(result.role).toBe('tool');
    expect(result.content).toContain('"page":1');
    expect(result.content).toContain('"page":3');
    expect(errors).toEqual([]);
});

test('go_to_page moves the viewer to the requested page', async ({ page }) => {
    const errors = watchErrors(page);
    await mockGateway(page, {
        tool: 'go_to_page',
        args: { page: 3 },
        answer: 'Showing page 3.',
    });
    await start(page);
    await ask(page, 'Go to page 3.');
    await expect(page.locator('.page-caption')).toHaveText('Page 3 of 4');
    await expectStep(page, 'Go to page 3');
    await expectAnswer(page, 'Showing page 3.');
    expect(errors).toEqual([]);
});

test('set_zoom changes the zoom control and the page scale', async ({ page }) => {
    const errors = watchErrors(page);
    await mockGateway(page, {
        tool: 'set_zoom',
        args: { mode: '125' },
        answer: 'Zoom is now 125%.',
    });
    await start(page);
    await ask(page, 'Zoom to 125 percent.');
    await expect(page.getByLabel('Zoom', { exact: true })).toHaveValue('1.25');
    await expect(page.locator('.paper')).toHaveCSS('width', '525px');
    await expectStep(page, 'Zoom to 125');
    await expectAnswer(page, 'Zoom is now 125%.');
    expect(errors).toEqual([]);
});

test('add_bookmark writes a bookmark the outline lists', async ({ page }) => {
    const errors = watchErrors(page);
    await mockGateway(page, {
        tool: 'add_bookmark',
        args: { title: 'Chapter One', page: 2 },
        answer: 'Bookmarked page 2 as Chapter One.',
    });
    await start(page);
    await ask(page, 'Bookmark page 2 as Chapter One.');
    await expectStep(page, 'Bookmark page 2 as "Chapter One"');
    await expectAnswer(page, 'Bookmarked page 2 as Chapter One.');
    await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
    const tabs = page.getByRole('tablist', { name: 'Side panel' });
    await expect(tabs.getByRole('tab', { name: 'Outline', exact: true })).toBeVisible();
    await tabs.getByRole('tab', { name: 'Outline', exact: true }).click();
    const tree = page.getByRole('tree', { name: 'Document outline' });
    await expect(tree.getByRole('treeitem', { name: 'Chapter One', exact: true })).toBeVisible();
    expect(errors).toEqual([]);
});

test('the Summarize button sends the summary prompt', async ({ page }) => {
    const errors = watchErrors(page);
    const requests = await mockGateway(page, { answer: 'This paper has four short pages.' });
    await start(page);
    await page.getByRole('button', { name: 'Summarize', exact: true }).click();
    await expectAnswer(page, 'This paper has four short pages.');
    expect(requests).toHaveLength(1);
    expect(requests[0].messages.at(-1).content).toContain(
        'Summarize this document in a short paragraph',
    );
    expect(errors).toEqual([]);
});
