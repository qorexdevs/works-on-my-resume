import { test, expect } from '@playwright/test';
import { clearAppStorage } from './helpers';

test.describe('Gist import', () => {
  test('rejects a truncated default file instead of previewing partial content', async ({
    page,
  }) => {
    await clearAppStorage(page);
    await page.route('https://api.github.com/gists/a1b2c3d4e5', async (route) => {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          files: {
            'resume.md': {
              filename: 'resume.md',
              language: 'Markdown',
              content: '# Jordan Lee\nPartial resume',
              truncated: true,
            },
          },
        }),
      });
    });

    await page.goto('');
    await page.getByText('Import from a public GitHub Gist', { exact: true }).click();
    await page.getByLabel('Gist URL').fill('https://gist.github.com/qorexdev/a1b2c3d4e5');
    await page.getByRole('button', { name: /^import$/i }).click();

    await expect(page.getByRole('alert')).toHaveText(/too large to import via the API/i);
    await expect(page.getByRole('heading', { name: 'Preview before importing' })).not.toBeVisible();
  });

  test('selects a populated Markdown file when an earlier Markdown file is empty', async ({
    page,
  }) => {
    await clearAppStorage(page);
    await page.route('https://api.github.com/gists/abcde12345', async (route) => {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          files: {
            'README.md': {
              filename: 'README.md',
              language: 'Markdown',
              content: '',
            },
            'resume.md': {
              filename: 'resume.md',
              language: 'Markdown',
              content: '# Jordan Lee',
            },
          },
        }),
      });
    });

    await page.goto('');
    await page.getByText('Import from a public GitHub Gist', { exact: true }).click();
    await page.getByLabel('Gist URL').fill('https://gist.github.com/qorexdev/abcde12345');
    await page.getByRole('button', { name: /^import$/i }).click();

    const preview = page.getByRole('heading', { name: 'Preview before importing' });
    await expect(preview).toBeVisible();
    await expect(page.getByLabel(/^file \(2\)$/i)).toHaveValue('1');
    await expect(page.getByLabel('Gist file preview')).toHaveText('# Jordan Lee');
  });
});
