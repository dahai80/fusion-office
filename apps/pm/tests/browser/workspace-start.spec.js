import { test, expect } from '@playwright/test';

test('starts the local workspace and creates a project', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.goto('/');
  await expect(page.getByText('Could not start the local workspace')).toHaveCount(0);
  const nav = page.getByRole('navigation', { name: 'Main navigation' });
  await expect(nav).toBeVisible();
  const onboarding = page.getByRole('heading', { name: 'Welcome' });
  if (await onboarding.isVisible().catch(() => false)) {
    await page.getByRole('button', { name: 'Skip for now' }).click();
    await expect(onboarding).toHaveCount(0);
  }
  await nav.getByRole('button', { name: 'New project' }).click();
  const dialog = page.getByRole('heading', { name: 'New project' });
  await expect(dialog).toBeVisible();
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Acceptance project');
  await page.getByRole('button', { name: 'Create project' }).click();
  expect(errors).toEqual([]);
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Acceptance project' })).toBeVisible();
});
