/**
 * Checking REST responses against the OpenAPI contract they were imported from, end to end.
 *
 * The unit and IPC suites prove the check, the worker's deadline and the chip's wording one layer at
 * a time. What only the real app can prove is the chain: an imported request remembers its
 * operation, a send runs the check against the cached definition, and the result reaches the status
 * line's chip, the Pretty body's markers, the Problems panel (whose row reveals the problem) and the
 * History entry.
 *
 * Everything is local: the document and the two item bodies are served by the in-process REST test
 * server, which also answers `/status/503` with a JSON body of its own.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { launchApp, type LaunchedApp } from '../helpers/launch-app.js';
import { createProject, createWorkspace } from '../helpers/project.js';
import { apiRow, folderRow, importOpenApiByUrl, responseStatus, restRequestRow, sendRest } from '../helpers/rest.js';
import { startTestRestServer, type TestRestServer } from '../helpers/test-server.js';

/** A small contract: two item routes that promise a `name`, and a status route that promises only a 200. */
function contract(serverUrl: string): string {
  return `openapi: 3.0.3
info:
  title: Items
  version: '1.0'
servers:
  - url: ${serverUrl}
paths:
  /items/good:
    get:
      summary: Good item
      responses:
        '200':
          description: An item
          content:
            application/json:
              schema: { $ref: '#/components/schemas/Item' }
  /items/broken:
    get:
      summary: Broken item
      responses:
        '200':
          description: An item
          content:
            application/json:
              schema: { $ref: '#/components/schemas/Item' }
  /status/503:
    get:
      summary: Busy
      responses:
        '200':
          description: Fine
          content:
            application/json:
              schema: { type: object }
components:
  schemas:
    Item:
      type: object
      required: [id, name]
      properties:
        id: { type: integer }
        name: { type: string }
        owner:
          type: object
          properties:
            age: { type: integer }
`;
}

/**
 * The slice of the Monaco namespace this spec reads through `globalThis.__wirebenchMonaco`.
 * Hand-written rather than imported: `monaco-editor` is a renderer dependency, not the e2e package's.
 */
interface MonacoHandle {
  readonly editor: {
    getModelMarkers(filter: { owner?: string }): { message: string; startLineNumber: number }[];
    getEditors(): { getSelection(): { startLineNumber: number } | null }[];
  };
}

/** The markers Monaco holds under the contract owner. */
async function contractMarkers(page: Page): Promise<{ message: string; startLineNumber: number }[]> {
  return page.evaluate(() => {
    const monaco = (globalThis as unknown as { __wirebenchMonaco?: MonacoHandle }).__wirebenchMonaco;
    if (monaco === undefined) {
      return [];
    }
    return monaco.editor
      .getModelMarkers({ owner: 'wirebench-contract' })
      .map((marker) => ({ message: marker.message, startLineNumber: marker.startLineNumber }));
  });
}

async function openImported(page: Page, folder: string, name: string): Promise<void> {
  const row = restRequestRow(page, name);
  if (!(await row.isVisible())) {
    await folderRow(page, folder).click();
  }
  await row.dblclick();
  await expect(page.getByTestId('rest-editor')).toBeVisible({ timeout: 20_000 });
}

test.describe('REST response validation', () => {
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

  test('passes a clean 200, marks a missing field, and flags an undeclared status', async () => {
    // Filled in after the server starts: the document has to name the port it is served on.
    const documents: Record<string, { body: string; contentType: string }> = {};
    server = await startTestRestServer({ documents });
    documents['/openapi.yaml'] = { body: contract(server.url), contentType: 'application/yaml' };
    documents['/items/good'] = { body: '{"id":1,"name":"widget"}', contentType: 'application/json' };
    documents['/items/broken'] = { body: '{"id":2,"owner":{"age":"old"}}', contentType: 'application/json' };

    userDataDir = mkdtempSync(join(tmpdir(), 'wirebench-contract-'));
    launched = await launchApp({ userDataDir, keepUserDataDir: true });
    const page = launched.window;
    await createWorkspace(page, 'Contracts');
    await createProject(page, 'Items');
    await importOpenApiByUrl(page, `${server.url}/openapi.yaml`);
    await expect(apiRow(page, 'Items')).toBeVisible({ timeout: 20_000 });
    await apiRow(page, 'Items').click();
    await expect(folderRow(page, 'items')).toBeVisible({ timeout: 20_000 });

    const chip = page.getByTestId('rest-contract-chip');

    // A clean 200: the chip says so, and the body carries no marker.
    await openImported(page, 'items', 'Good item');
    await sendRest(page);
    await expect(responseStatus(page)).toContainText('200');
    await expect(chip).toHaveText('Contract ✓', { timeout: 20_000 });
    await expect(chip).toHaveAttribute('data-tone', 'success');
    await expect.poll(async () => (await contractMarkers(page)).length, { timeout: 20_000 }).toBe(0);

    // A 200 without `name` and with a nested field of the wrong type: two problems on the chip,
    // markers in the Pretty body, a Problems row each.
    await openImported(page, 'items', 'Broken item');
    await sendRest(page);
    await expect(chip).toHaveText('Contract: 2 problems', { timeout: 20_000 });
    await expect(chip).toHaveAttribute('data-tone', 'warning');
    await expect
      .poll(async () => (await contractMarkers(page)).map((marker) => marker.message).join('\n'), { timeout: 20_000 })
      .toContain('missing required property "name"');

    await page.getByTestId('status-bar-problems').click();
    await expect(page.getByTestId('problem-row').filter({ hasText: 'missing required property "name"' })).toBeVisible({
      timeout: 20_000,
    });
    // The wrong-typed `owner.age` sits below the first line of the pretty-printed body, so revealing
    // it proves the row lands on the property rather than on the fallback line 1.
    const row = page.getByTestId('problem-row').filter({ hasText: 'expected integer, got string' });
    await expect(row).toBeVisible({ timeout: 20_000 });
    await row.click();
    await expect
      .poll(
        async () =>
          await page.evaluate((): number => {
            const monaco = (globalThis as unknown as { __wirebenchMonaco?: MonacoHandle }).__wirebenchMonaco;
            return (
              monaco?.editor
                .getEditors()
                .find((e) => e.getSelection() !== null)
                ?.getSelection()?.startLineNumber ?? 0
            );
          }),
        { timeout: 15_000 },
      )
      .toBeGreaterThan(1);

    // A 503 the operation never declared: `Unexpected status`, and nothing filed as a problem.
    await openImported(page, 'status', 'Busy');
    await sendRest(page);
    await expect(responseStatus(page)).toContainText('503');
    await expect(chip).toHaveText('Unexpected status', { timeout: 20_000 });
    await expect(chip).toHaveAttribute('data-tone', 'warning');

    // History keeps the verdict: the 503's entry shows the same chip.
    const historySidebar = page.locator('[data-testid="sidebar"][aria-label="History"]');
    if (!(await historySidebar.isVisible().catch(() => false))) {
      await page.getByTestId('activity-bar').getByRole('button', { name: 'History' }).click();
    }
    const rows = page.getByTestId('history-row');
    await expect(rows).toHaveCount(3, { timeout: 20_000 });
    await rows.filter({ hasText: '503' }).first().click();
    await expect(page.getByTestId('rest-contract-chip').filter({ hasText: 'Unexpected status' }).first()).toBeVisible({
      timeout: 20_000,
    });
  });
});
