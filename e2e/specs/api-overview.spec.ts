/**
 * The REST API Overview end to end (API Overview spec §10): an imported collection's Markdown
 * description shows rendered on the page an API opens on, is edited in place, the summary counts
 * what the API holds, Recent changes says why a local workspace has no history, and View complete
 * documentation opens the docs tab with every folder and request.
 */
import { expect, test } from '@playwright/test';
import { launchApp, type LaunchedApp } from '../helpers/launch-app.js';
import { createProject, createWorkspace, openImportDialog } from '../helpers/project.js';
import { apiRow, openApiTab } from '../helpers/rest.js';

const COLLECTION = JSON.stringify({
  info: {
    name: 'Cards',
    description: '## Flow\n\n1. Sign in\n2. Issue a card\n\n<script>window.injected = true</script>',
    schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
  },
  item: [
    {
      name: 'Issuing',
      description: 'Everything that **creates** a card.',
      item: [
        {
          name: 'Issue a card',
          request: {
            method: 'POST',
            url: 'https://cards.example.com/cards',
            description: 'Creates a *virtual* card.',
          },
        },
      ],
    },
    { name: 'List cards', request: { method: 'GET', url: 'https://cards.example.com/cards' } },
  ],
});

test.describe('REST API Overview', () => {
  let launched: LaunchedApp | undefined;

  test.afterEach(async () => {
    await launched?.close();
    launched = undefined;
  });

  test('shows the description rendered, edits it, and opens the full documentation', async () => {
    launched = await launchApp();
    const page = launched.window;
    await createWorkspace(page, 'Overview');
    await createProject(page, 'Cards project');

    await openImportDialog(page, 'postman');
    await page.getByRole('tab', { name: 'Paste' }).click();
    await page.getByTestId('import-postman-paste').fill(COLLECTION);
    await page.getByTestId('import-postman-submit').click();
    await page.getByTestId('import-postman-done').click();
    await expect(apiRow(page, 'Cards')).toBeVisible({ timeout: 20_000 });

    // The page opens on the Overview, with the description rendered and its raw HTML left out.
    await openApiTab(page, 'Cards');
    const overview = page.getByTestId('api-overview');
    await expect(overview).toBeVisible();
    await expect(overview.getByRole('heading', { name: 'Flow' })).toBeVisible();
    await expect(overview.locator('ol li')).toHaveCount(2);
    expect(await page.evaluate(() => (window as { injected?: boolean }).injected)).toBeUndefined();

    // The summary counts what the API holds; a local workspace has no history to show.
    await expect(page.getByTestId('api-summary-requests')).toHaveText('2 requests');
    await expect(page.getByTestId('api-summary-folders')).toHaveText('1 folder');
    await expect(page.getByTestId('recent-changes-unavailable')).toContainText('not under version control');

    // Edited in place: the source text, then the rendered result.
    await page.getByTestId('api-overview-edit').click();
    await page.getByTestId('api-overview-editor').fill('A **new** description.');
    await page.getByTestId('api-overview-save').click();
    await expect(overview.locator('strong')).toHaveText('new');

    // The full documentation: every folder and request, with their own descriptions.
    await page.getByTestId('api-overview-docs').click();
    const docs = page.getByTestId('api-docs-tab');
    await expect(docs).toBeVisible({ timeout: 20_000 });
    await expect(docs.getByTestId('api-docs-folder')).toHaveCount(1);
    await expect(docs.getByTestId('api-docs-request')).toHaveCount(2);
    await expect(docs.getByTestId('api-docs-folder').locator('strong')).toHaveText('creates');
    await expect(docs.getByTestId('api-docs-request').first()).toContainText('Creates a virtual card.');
  });
});
