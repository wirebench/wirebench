/**
 * A GraphQL request end to end (#77): created from the API's menu, its schema fetched through the
 * request itself, its query checked and completed against that schema, and a response whose `errors`
 * reach the chip and the Problems panel.
 *
 * The unit and IPC suites cover each layer. What only the real app proves is the chain: the
 * introspection goes out through the request's own URL, the schema comes back to the editor through
 * the project snapshot, and Monaco shows main's answers.
 *
 * Everything is local: the in-process REST test server answers GraphQL at `/graphql`.
 */
import { expect, test, type Page } from '@playwright/test';
import { setMonacoText } from '../helpers/editor.js';
import { launchApp, type LaunchedApp } from '../helpers/launch-app.js';
import { createProject, createWorkspace } from '../helpers/project.js';
import {
  apiRow,
  chooseContextMenuItem,
  createApi,
  openRequestTab,
  responseStatus,
  restRequestRow,
  sendRest,
  setMethodAndUrl,
} from '../helpers/rest.js';
import { startTestRestServer, type TestRestServer } from '../helpers/test-server.js';

/** The slice of the Monaco namespace this spec reads through `globalThis.__wirebenchMonaco`. */
interface MonacoHandle {
  readonly editor: {
    getModelMarkers(filter: { owner?: string }): { message: string }[];
    getEditors(): {
      getDomNode(): { querySelector(selector: string): unknown } | null;
      setPosition(position: { lineNumber: number; column: number }): void;
      focus(): void;
      trigger(source: string, handlerId: string, payload: unknown): void;
    }[];
  };
}

/** The messages of the markers Monaco holds under `owner`, joined. */
async function markerMessages(page: Page, owner: string): Promise<string> {
  return page.evaluate((markerOwner) => {
    const monaco = (globalThis as unknown as { __wirebenchMonaco?: MonacoHandle }).__wirebenchMonaco;
    return (monaco?.editor.getModelMarkers({ owner: markerOwner }) ?? []).map((marker) => marker.message).join('\n');
  }, owner);
}

/** Puts the caret of the editor labelled `label` at `column` of line 1 and asks Monaco for suggestions. */
async function triggerSuggest(page: Page, label: string, column: number): Promise<void> {
  await page.evaluate(
    ({ editorLabel, at }) => {
      const monaco = (globalThis as unknown as { __wirebenchMonaco?: MonacoHandle }).__wirebenchMonaco;
      const editor = monaco?.editor
        .getEditors()
        .find((candidate) => candidate.getDomNode()?.querySelector(`[aria-label="${editorLabel}"]`) != null);
      editor?.focus();
      editor?.setPosition({ lineNumber: 1, column: at });
      editor?.trigger('e2e', 'editor.action.triggerSuggest', {});
    },
    { editorLabel: label, at: column },
  );
}

test.describe('GraphQL requests', () => {
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

  test('fetches the schema, checks and completes the query, and reports the response errors', async () => {
    server = await startTestRestServer();
    launched = await launchApp();
    const page = launched.window;

    await createWorkspace(page, 'GraphQL');
    await createProject(page, 'Shop');
    await createApi(page, 'Shop', server.url);
    await chooseContextMenuItem(page, apiRow(page, 'Shop'), 'New GraphQL request');
    await expect(page.getByTestId('rest-editor')).toBeVisible({ timeout: 20_000 });
    // The new request sits under the API, which may still be folded: unfold it to see the badge, then
    // reopen the request, since a click on the API row opens the API's own tab.
    const row = restRequestRow(page, 'New GraphQL request');
    await expect(async () => {
      if (!(await row.isVisible())) {
        await apiRow(page, 'Shop').click();
      }
      await expect(row.getByTestId('method-badge')).toHaveText('GQL', { timeout: 2_000 });
    }).toPass({ timeout: 20_000 });
    await row.dblclick();
    await expect(page.getByTestId('rest-editor')).toBeVisible({ timeout: 20_000 });
    await setMethodAndUrl(page, 'POST', '/graphql');

    // The body is GraphQL already; its schema is fetched through the request's own URL.
    await openRequestTab(page, 'Body');
    await expect(page.getByTestId('rest-body-kind')).toHaveValue('graphql');
    await expect(page.getByTestId('rest-graphql-schema')).toHaveText('No schema');
    await page.getByTestId('rest-graphql-fetch').click();
    await expect(page.getByTestId('rest-graphql-schema')).toContainText(`Schema from ${server.url}/graphql`, {
      timeout: 20_000,
    });

    // A field the schema does not have is marked; completion offers the ones it does.
    await setMonacoText(page, 'GraphQL query', '{ product(id: "1") { nam } }');
    await expect
      .poll(() => markerMessages(page, 'wirebench-graphql'), { timeout: 20_000 })
      .toContain('Cannot query field "nam"');
    await expect(async () => {
      await triggerSuggest(page, 'GraphQL query', 25);
      await expect(page.locator('.suggest-widget').getByText('name', { exact: true })).toBeVisible({
        timeout: 2_000,
      });
    }).toPass({ timeout: 20_000 });
    await page.keyboard.press('Escape');

    // A resolver that throws: HTTP 200, but the chip and the Problems panel carry its error.
    await setMonacoText(page, 'GraphQL query', '{ boom }');
    await sendRest(page);
    await expect(responseStatus(page)).toContainText('200');
    const chip = page.getByTestId('rest-graphql-chip');
    await expect(chip).toHaveText('1 GraphQL error', { timeout: 20_000 });
    await expect(chip).toHaveAttribute('data-tone', 'danger');
    await page.getByTestId('status-bar-problems').click();
    await expect(page.getByTestId('problem-row').filter({ hasText: 'Boom from the resolver' })).toBeVisible({
      timeout: 20_000,
    });
  });
});
