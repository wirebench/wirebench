/**
 * cURL both ways, through the real app.
 *
 * The engine tests pin the text and the parse; what only the app can show is that the Code panel
 * describes the request the user is actually looking at, and that a pasted command becomes a request
 * that sends — the round trip, not either half of it.
 */
import { expect, test } from '@playwright/test';
import { launchApp, type LaunchedApp } from '../helpers/launch-app.js';
import { createProject, createWorkspace, dismissChangedOnDiskBanners } from '../helpers/project.js';
import {
  addHeader,
  apiRow,
  createApi,
  createRestRequest,
  openRequestTab,
  responseStatus,
  sendRest,
  setMethodAndUrl,
} from '../helpers/rest.js';
import { startTestRestServer, type TestRestServer } from '../helpers/test-server.js';

/** Opens the Code slide-over, which is where a command is read and copied. */
async function openCodePanel(page: import('@playwright/test').Page): Promise<void> {
  await page.getByRole('button', { name: 'Code' }).click();
  await expect(page.getByTestId('code-panel')).toBeVisible({ timeout: 20_000 });
}

test.describe('cURL', () => {
  let launched: LaunchedApp | undefined;
  let server: TestRestServer | undefined;

  test.afterEach(async () => {
    if (launched) {
      await launched.close();
      launched = undefined;
    }
    await server?.close();
    server = undefined;
  });

  test('shows the REST request in front of the user as a command, secrets masked', async () => {
    server = await startTestRestServer();
    launched = await launchApp();
    const page = launched.window;

    await createWorkspace(page, 'cURL');
    await createProject(page, 'Pets');
    await createApi(page, 'Petstore', server.url);
    await createRestRequest(page, 'Petstore', 'Echo');
    await setMethodAndUrl(page, 'POST', '/echo?dry=true');
    await addHeader(page, 'X-Trace', 'abc');

    // A Bearer token, so the masking rule has something to mask.
    await openRequestTab(page, 'Auth');
    await page.getByLabel('Request authentication type').selectOption('bearer');
    await page.getByRole('button', { name: 'Set…' }).click();
    await page.getByLabel('Request token').fill('tok-live');
    await page.getByRole('button', { name: 'Save' }).click();

    await openCodePanel(page);

    const preview = page.getByTestId('code-panel-preview');
    await expect(preview).toContainText('--request POST', { timeout: 20_000 });
    await expect(preview).toContainText('/echo?dry=true');
    await expect(preview).toContainText('X-Trace: abc');
    // Show-secrets is off, so the command carries the shape of the credential and not its value.
    await expect(preview).toContainText('Authorization: <redacted>');
    await expect(preview).not.toContainText('tok-live');
  });

  test('imports a pasted command into an API, and the request it makes sends', async () => {
    server = await startTestRestServer();
    launched = await launchApp();
    const page = launched.window;

    await createWorkspace(page, 'cURL');
    await createProject(page, 'Pets');
    await createApi(page, 'Petstore', server.url);

    await apiRow(page, 'Petstore').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Import cURL…' }).click();
    // The dialog says where the request will land, so an import cannot go somewhere unintended.
    await expect(page.getByTestId('import-curl-target')).toContainText('the API “Petstore”');

    await page.getByLabel('cURL command').click();
    await page.keyboard.insertText(
      `curl -X POST '${server.url}/echo?dry=true' -H 'Content-Type: application/json' -H 'X-From: curl' -d '{"name":"Fido"}'`,
    );
    await page.getByTestId('import-curl-submit').click();

    // The imported request opens in its own editor, with the fields the command described.
    await expect(page.getByTestId('rest-editor')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('rest-method')).toHaveValue('POST');
    // The path is the URL and the query is a table: that split is what the import is for.
    await expect(page.getByTestId('rest-url')).toHaveValue('/echo');
    await openRequestTab(page, 'Params');
    // An input's value is not its text content, so the row is checked by value.
    await expect(page.getByTestId('rest-query-row').getByRole('textbox').first()).toHaveValue('dry');

    await sendRest(page);

    await expect(responseStatus(page)).toContainText('200');
    // The import wrote the project folder, so the watcher may have raised a "changed on disk"
    // banner above the editor. It is two rows tall, and the body pane virtualises: with the banner
    // up, the echoed header falls off the bottom of what is rendered.
    await dismissChangedOnDiskBanners(page);
    // The echoed header sits near the top of the response, so it is reliably on screen.
    await expect(page.getByTestId('rest-response-body')).toContainText('x-from', { timeout: 20_000 });
    // The body is checked against the server's own record, not the response pane. That pane
    // virtualises its lines, and the echo puts `body` *after* the header block: CI rendered 14
    // lines and the body lands on line 16, so this assertion passed on Linux (a taller window)
    // and failed on Windows and macOS. `requests` exists for exactly this — "assertions the
    // response cannot carry" — and it proves the stronger thing anyway: the bytes reached the
    // server, rather than merely being drawn back to us.
    expect(server.requests.at(-1)?.body.toString('utf8')).toContain('Fido');
  });

  test('a pasted -u password goes to the keychain, and the request authenticates with it', async () => {
    server = await startTestRestServer();
    launched = await launchApp();
    const page = launched.window;

    await createWorkspace(page, 'cURL');
    await createProject(page, 'Pets');
    await createApi(page, 'Petstore', server.url);

    await apiRow(page, 'Petstore').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Import cURL…' }).click();
    await page.getByLabel('cURL command').click();
    await page.keyboard.insertText(`curl -u u:p ${server.url}/auth/basic`);
    await page.getByTestId('import-curl-submit').click();

    await expect(page.getByTestId('rest-editor')).toBeVisible({ timeout: 20_000 });
    // Nothing left to type: the toast does not ask for a password.
    await expect(page.getByText(/set a password for/)).toHaveCount(0);
    await sendRest(page);
    await expect(responseStatus(page)).toContainText('200');
  });

  test('round-trips: copy a request as a command, paste it back, send the copy', async () => {
    server = await startTestRestServer();
    launched = await launchApp();
    const page = launched.window;

    await createWorkspace(page, 'cURL');
    await createProject(page, 'Pets');
    await createApi(page, 'Petstore', server.url);
    await createRestRequest(page, 'Petstore', 'Original');
    await setMethodAndUrl(page, 'POST', '/echo');
    await addHeader(page, 'X-Round', 'trip');

    await openCodePanel(page);
    await expect(page.getByTestId('code-panel-preview')).toContainText('X-Round: trip', { timeout: 20_000 });
    // Read the command through Copy rather than by scraping the highlighted preview: the preview is
    // one element per token, so its text content loses exactly the newlines a heredoc needs.
    await page.getByTestId('code-panel-copy').click();
    const command = await page.evaluate(() =>
      (navigator as Navigator & { readonly clipboard: { readText(): Promise<string> } }).clipboard.readText(),
    );
    expect(command).toContain('X-Round: trip');

    // Straight back in through the import dialog, which is the whole point of the two halves.
    await page.getByTestId('code-panel-import').click();
    await page.getByLabel('cURL command').click();
    await page.keyboard.insertText(command);
    await page.getByTestId('import-curl-submit').click();

    await expect(page.getByTestId('rest-editor')).toBeVisible({ timeout: 20_000 });
    // The Code slide-over is still open over the editor, and it would swallow the Send click.
    await page.getByRole('button', { name: 'Code' }).click();
    await expect(page.getByTestId('code-panel')).toBeHidden();
    await sendRest(page);
    await expect(responseStatus(page)).toContainText('200');
    await expect(page.getByTestId('rest-response-body')).toContainText('x-round', { timeout: 20_000 });
    // Two requests now: the original is still open beside the imported copy, not replaced by it.
    await expect(page.getByRole('tab', { name: /^Original/ })).toBeVisible();
  });
});
