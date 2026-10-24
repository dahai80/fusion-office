import { test, expect } from '@playwright/test';

test('starts a local workbook and keeps an edited cell', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByText('Could not start the local workspace')).toHaveCount(0);
  const grid = page.getByRole('grid', { name: 'Spreadsheet grid' });
  await expect(grid).toBeVisible();
  await grid.click();
  await page.keyboard.type('42');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('gridcell', { name: '42' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('collapses and reopens the assistant panel', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  const message = page.getByRole('textbox', { name: 'Message the assistant' });
  if (!(await message.isVisible().catch(() => false))) {
    await page.getByRole('button', { name: 'Expand the assistant' }).click();
  }
  await expect(page.getByRole('heading', { name: 'Assistant' })).toBeVisible();
  await page.getByRole('button', { name: 'Collapse the assistant' }).click();
  const rail = page.getByRole('button', { name: 'Expand the assistant' });
  await expect(rail).toBeVisible();
  await rail.click();
  await expect(message).toBeVisible();
  expect(errors).toEqual([]);
});
