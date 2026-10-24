import { test, expect } from '@playwright/test';

test('starts the local workspace without a page SDK', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('textbox', { name: 'Document text' })).toBeVisible();
  await expect(page.getByText('Could not start the workspace')).toHaveCount(0);
  expect(errors).toEqual([]);
});
