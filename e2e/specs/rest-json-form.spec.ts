/**
 * The JSON body's Text/Form switch, end to end.
 *
 * The unit and renderer suites prove the engine's tree-building and edits, and the form view's own
 * behaviour in isolation. What only the real app can prove is the chain from an imported operation's
 * cached schema to the switch appearing on the Body tab, a field typed into the form landing back in
 * the raw text, and a numeric field accepting digits.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { launchApp, type LaunchedApp } from '../helpers/launch-app.js';
import { createProject, createWorkspace } from '../helpers/project.js';
import { apiRow, folderRow, importOpenApiByUrl, openRequestTab, restRequestRow } from '../helpers/rest.js';
import { startTestRestServer, type TestRestServer } from '../helpers/test-server.js';
import { monacoModelText } from '../helpers/editor.js';

/** A small contract: one POST whose JSON body has a required string and an optional number. */
function contract(serverUrl: string): string {
  return `openapi: 3.0.3
info:
  title: Items
  version: '1.0'
servers:
  - url: ${serverUrl}
paths:
  /items:
    post:
      summary: Create item
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [name]
              properties:
                name: { type: string }
                quantity: { type: integer }
`;
}

test.describe('REST JSON body form', () => {
  let launched: LaunchedApp | undefined;
  let server: TestRestServer | undefined;
  let userDataDir: string | undefined;

  test.afterEach(async () => {
    if (launched) {
      await launched.close();
      launched = undefined;
    }
    await server?.close();
    server = undefined;
    if (userDataDir !== undefined) {
      rmSync(userDataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
      userDataDir = undefined;
    }
  });

  test('fills a field on the form and sees it in the raw text, and accepts a typed number', async () => {
    const documents: Record<string, { body: string; contentType: string }> = {};
    server = await startTestRestServer({ documents });
    documents['/openapi.yaml'] = { body: contract(server.url), contentType: 'application/yaml' };

    userDataDir = mkdtempSync(join(tmpdir(), 'wirebench-json-form-'));
    launched = await launchApp({ userDataDir, keepUserDataDir: true });
    const page = launched.window;
    await createWorkspace(page, 'Contracts');
    await createProject(page, 'Items');
    await importOpenApiByUrl(page, `${server.url}/openapi.yaml`);
    await expect(apiRow(page, 'Items')).toBeVisible({ timeout: 20_000 });
    await apiRow(page, 'Items').click();
    await expect(folderRow(page, 'items')).toBeVisible({ timeout: 20_000 });
    await folderRow(page, 'items').click();

    await restRequestRow(page, 'Create item').dblclick();
    await expect(page.getByTestId('rest-editor')).toBeVisible({ timeout: 20_000 });

    await openRequestTab(page, 'Body');
    const formSwitch = page.getByTestId('rest-body-view-form');
    await expect(formSwitch).toBeVisible({ timeout: 20_000 });

    await formSwitch.click();
    await expect(formSwitch).toHaveAttribute('aria-pressed', 'true');
    const form = page.getByTestId('json-form-view');
    await expect(form).toBeVisible({ timeout: 20_000 });

    const nameField = form.getByRole('textbox', { name: 'name', exact: true });
    await nameField.fill('widget');

    // The quantity field is optional, so it must be added before it can be typed into.
    await form.getByRole('button', { name: 'Add quantity' }).click();
    const quantityField = form.getByRole('spinbutton', { name: 'quantity', exact: true });
    await quantityField.fill('7');
    await expect(quantityField).toHaveValue('7');

    await page.getByTestId('rest-body-view-text').click();
    await expect(page.getByTestId('rest-body-view-text')).toHaveAttribute('aria-pressed', 'true');

    await expect.poll(() => monacoModelText(page), { timeout: 20_000 }).toContain('"name": "widget"');
    await expect.poll(() => monacoModelText(page), { timeout: 20_000 }).toContain('"quantity": 7');
  });
});
