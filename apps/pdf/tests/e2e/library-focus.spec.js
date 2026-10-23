import { test, expect } from '@playwright/test';

for (const action of ['Rename', 'Duplicate', 'Delete'])
  for (const movedFocus of [false, true])
    test(`${action} completion ${movedFocus ? 'preserves newer keyboard focus' : 'restores focus after refreshing the library'}`, async ({
      page,
    }) => {
      await page.route('https://js.puter.com/**', (route) =>
        route.fulfill({
          contentType: 'application/javascript',
          body: `
            window.libraryNames = ['report.pdf', 'second.pdf'];
            const hold = update => new Promise(resolve => {
              window.finishLibraryAction = () => { update(); resolve({}); };
            });
            window.puter = {
              env: 'web',
              auth: {isSignedIn: () => true, getUser: async () => ({username: 'test-user'})},
              fs: {
                readdir: async () => window.libraryNames.map(name => ({name, path: 'PDF Editor/' + name})),
                read: async () => new Blob(['%PDF-1.4']),
                rename: () => hold(() => { window.libraryNames[0] = 'renamed.pdf'; }),
                write: () => hold(() => { window.libraryNames.push('report copy.pdf'); }),
                delete: () => hold(() => { window.libraryNames.shift(); })
              }
            };`,
        }),
      );
      await page.goto('/#library');
      await page.getByRole('button', { name: 'Options for report.pdf', exact: true }).click();
      await page.getByRole('button', { name: action, exact: true }).click();
      if (action === 'Rename') {
        const dialog = page.getByRole('dialog', { name: 'Rename PDF', exact: true });
        await dialog.getByLabel('File name').fill('renamed');
        await dialog.getByRole('button', { name: 'Continue', exact: true }).click();
      } else if (action === 'Delete') {
        await page
          .getByRole('dialog', { name: 'Delete PDF?', exact: true })
          .getByRole('button', { name: 'Delete PDF', exact: true })
          .click();
      }
      await expect
        .poll(() => page.evaluate(() => typeof window.finishLibraryAction))
        .toBe('function');
      const search = page.getByRole('searchbox', { name: 'Search PDFs', exact: true });
      const sort = page.getByLabel('Sort PDFs', { exact: true });
      if (movedFocus) {
        if (action === 'Duplicate') await page.keyboard.press('Escape');
        await expect(page.locator('dialog')).toHaveCount(0);
        await search.press('Shift+Tab');
        await expect(sort).toBeFocused();
      }
      await page.evaluate(() => window.finishLibraryAction());
      await expect(page.locator('.file-open')).toHaveText(
        {
          Rename: ['renamed.pdf', 'second.pdf'],
          Duplicate: ['report.pdf', 'second.pdf', 'report copy.pdf'],
          Delete: ['second.pdf'],
        }[action],
      );
      await expect(page.locator('dialog')).toHaveCount(0);
      await expect(movedFocus ? sort : search).toBeFocused();
    });
