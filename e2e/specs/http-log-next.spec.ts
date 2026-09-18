import { expect, test } from '@playwright/test';
import { launchApp, type LaunchedApp } from '../helpers/launch-app.js';
import { createProject, createWorkspace } from '../helpers/project.js';
import { createApi, createRestRequest, responseStatus, sendRest, setMethodAndUrl } from '../helpers/rest.js';
import { logRows, selectLogRow } from '../helpers/http-log.js';

test.describe('HTTP Log: export, reuse, search, waterfall, compare', () => {
  let launched: LaunchedApp | undefined;

  test.afterEach(async () => {
    if (launched) {
      await launched.close();
    }
    launched = undefined;
  });

  test('S1: an unparseable base URL produces a "Failed · before send" row', async () => {
    launched = await launchApp();
    const page = launched.window;
    await createWorkspace(page, 'Log');
    await createProject(page, 'Pets');
    await createApi(page, 'Broken', 'ht!tp://');
    await createRestRequest(page, 'Broken', 'Bad');
    await setMethodAndUrl(page, 'GET', '/x');
    await sendRest(page);
    // The engine refuses the URL while composing it, before any request is built.
    await expect(responseStatus(page)).toContainText(/rest-url-incomplete|invalid-url/);

    const row = logRows(page).last();
    await expect(row).toHaveAttribute('data-kind', 'failure');
    await expect(row.getByTestId('http-log-status')).toHaveText('Failed · before send');
    await selectLogRow(row);
    await page.getByRole('tablist', { name: 'Log detail' }).getByRole('tab', { name: 'Response' }).click();
    await expect(page.getByTestId('log-detail-error')).toContainText('never went on the wire');
  });
});
