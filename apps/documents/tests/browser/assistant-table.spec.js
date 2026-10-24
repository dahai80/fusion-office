import { test, expect } from '@playwright/test';

const text = page => page.getByRole('textbox', { name: 'Document text' });

test('the Assistant inserts a table reply as a real table', async ({ page }) => {
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/mock.html#/new');
    await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
    await page.locator('.as-title-button').click();
    const pane = page.getByRole('complementary', { name: 'Assistant pane' });
    await expect(pane).toBeVisible();
    await pane.getByRole('textbox', { name: 'Message the assistant' }).fill('在文档中帮我建立一个表格，输出词汇');
    await pane.getByRole('textbox', { name: 'Message the assistant' }).press('Enter');
    await expect(pane.getByText(/Table · 3 rows · 2 columns/)).toBeVisible();
    await pane.getByRole('button', { name: 'Insert Table at Cursor' }).click();
    await expect(pane.getByText('Table inserted')).toBeVisible();
    // Cell paragraphs serialise one per line; a plain text insert would keep the pipe markup.
    await expect(text(page)).toHaveValue(/Word\nMeaning\napple\n苹果\nbridge\n桥\ncloud\n云/);
    await expect(page.getByRole('tab', { name: 'Table Layout' })).toBeVisible();
    await pane.getByRole('button', { name: 'Undo' }).click();
    await expect(text(page)).not.toHaveValue(/apple/);
    expect(errors).toEqual([]);
});
