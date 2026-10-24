import { test, expect } from '@playwright/test';

const text = page => page.getByRole('textbox', { name: 'Document text' });
const editorText = page => text(page).evaluate(el => el.value);

async function openAssistant(page, content) {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/mock.html#/new');
    await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
    await text(page).fill(content);
    await page.locator('.as-title-button').click();
    const pane = page.getByRole('complementary', { name: 'Assistant pane' });
    await expect(pane).toBeVisible();
    return pane;
}

async function ask(pane, prompt) {
    const input = pane.getByRole('textbox', { name: 'Message the assistant' });
    await input.fill(prompt);
    await input.press('Enter');
    await expect(pane.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
    await expect(pane.getByRole('button', { name: 'Send', exact: true })).toBeVisible({ timeout: 15000 });
}

test('the assistant reads the document, finds text and reports the outline', async ({ page }) => {
    const pane = await openAssistant(page, 'Alpha sentence. Beta line.');
    await ask(pane, 'Show the document info');
    await expect(pane.locator('.as-step-label').filter({ hasText: 'Read the document' })).toBeVisible();
    await expect(pane.getByText(/Done\./)).toBeVisible();
    await ask(pane, 'Find the word "Beta"');
    await expect(pane.locator('.as-step-label').filter({ hasText: 'Find "Beta"' })).toBeVisible();
    await expect(pane.getByText(/Done\./).last()).toBeVisible();
    await ask(pane, 'What is this about?');
    await expect(pane.locator('.as-answer').filter({ hasText: 'I read the document' }).last()).toBeVisible();
    await expect.poll(() => editorText(page)).toBe('Alpha sentence. Beta line.');
});

test('the assistant inserts text, a page break and a link', async ({ page }) => {
    const pane = await openAssistant(page, 'Opening line.');
    await ask(pane, 'Add a line at the end');
    await expect(pane.locator('.as-step-label').filter({ hasText: /Insert 2[0-9] characters at the end/ })).toBeVisible();
    await expect.poll(() => editorText(page)).toContain('Added by the assistant.');
    await ask(pane, 'Insert a page break');
    await expect(pane.locator('.as-step-label').filter({ hasText: 'Insert a page break' })).toBeVisible();
    await text(page).evaluate(el => { el.focus(); el.setSelectionRange(el.value.length, el.value.length); el.dispatchEvent(new Event('select')); });
    await ask(pane, 'Insert a link to the example site');
    await expect(pane.locator('.as-step-label').filter({ hasText: 'Add a link to https://example.com' })).toBeVisible();
    await expect.poll(() => editorText(page)).toContain('Example site');
});

test('the assistant replaces the selection only after approval', async ({ page }) => {
    const pane = await openAssistant(page, 'A long sentence here.');
    const input = pane.getByRole('textbox', { name: 'Message the assistant' });
    const send = async prompt => {
        await input.fill(prompt);
        await input.press('Enter');
    };
    const selectAll = () => text(page).evaluate(el => { el.focus(); el.setSelectionRange(0, el.value.length); el.dispatchEvent(new Event('select')); });

    await selectAll();
    await send('Rewrite it shorter');
    await expect(pane.getByRole('button', { name: 'Allow', exact: true })).toBeVisible();
    await pane.getByRole('button', { name: 'Allow', exact: true }).click();
    await expect.poll(() => editorText(page)).toBe('Shorter sentence.');
    await expect(pane.getByRole('button', { name: 'Send', exact: true })).toBeVisible({ timeout: 15000 });

    await selectAll();
    await send('Rewrite it shorter');
    await expect(pane.getByRole('button', { name: 'Skip', exact: true })).toBeVisible();
    await pane.getByRole('button', { name: 'Skip', exact: true }).click();
    await expect(pane.getByRole('button', { name: 'Send', exact: true })).toBeVisible({ timeout: 15000 });
    await expect.poll(() => editorText(page)).toBe('Shorter sentence.');
});

test('the assistant formats the document, and one undo takes it back', async ({ page }) => {
    const pane = await openAssistant(page, 'Format me.');
    await ask(pane, 'Make the text bold');
    await expect(pane.locator('.as-step-label').filter({ hasText: /Format the document: bold/ })).toBeVisible();
    await text(page).evaluate(el => { el.focus(); el.setSelectionRange(0, el.value.length); el.dispatchEvent(new Event('select')); });
    await expect(page.getByRole('button', { name: 'Bold', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await pane.getByRole('button', { name: 'Undo' }).click();
    await expect(page.getByRole('button', { name: 'Bold', exact: true })).toHaveAttribute('aria-pressed', 'false');
});
