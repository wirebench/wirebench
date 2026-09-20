import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { launchApp, type LaunchedApp } from '../helpers/launch-app.js';
import { chooseContextMenuItem } from '../helpers/rest.js';
import { createProject, createWorkspace, saveAll, workspaceProjectDir } from '../helpers/project.js';
import { startTestWsServer, type TestWsServer } from '../helpers/test-server.js';

/** Axe fails the spec at these impact levels, the same gate `a11y.spec.ts` uses. */
const GATED_IMPACTS = new Set(['serious', 'critical']);

test.describe('WebSocket: a request owns a session, its transcript, and its own HTTP Log row', () => {
  let launched: LaunchedApp | undefined;
  let server: TestWsServer | undefined;
  let userDataDir: string | undefined;

  test.beforeEach(async () => {
    server = await startTestWsServer();
    userDataDir = mkdtempSync(join(tmpdir(), 'wirebench-ws-'));
    launched = await launchApp({ userDataDir, keepUserDataDir: true });
  });

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

  test('connects to /echo, trades a message, closes with a chosen code, and shows up everywhere a send does', async () => {
    const page = launched!.window;
    await createWorkspace(page, 'WS');
    await createProject(page, 'Feeds');

    // New WebSocket API, its URL pointed at the test server's /echo path, then one request in it.
    const projectRow = page.getByTestId('explorer-project-row').first();
    await chooseContextMenuItem(page, projectRow, 'New WebSocket API…');
    await expect(page.getByTestId('ws-api-tab')).toBeVisible({ timeout: 20_000 });
    const apiNameField = page.getByTestId('ws-api-name');
    await apiNameField.fill('Echo API');
    await apiNameField.press('Enter');
    const apiUrlField = page.getByTestId('ws-api-url');
    await apiUrlField.fill(`${server!.url}/echo`);
    await apiUrlField.press('Enter');
    const apiRow = page.getByTestId('ws-api-row').filter({ hasText: 'Echo API' });
    await expect(apiRow).toBeVisible({ timeout: 20_000 });

    await chooseContextMenuItem(page, apiRow, 'New request');
    await expect(page.getByTestId('ws-editor')).toBeVisible({ timeout: 20_000 });
    const breadcrumbName = page.getByTestId('ws-breadcrumb-name');
    await breadcrumbName.dblclick();
    const nameInput = page.getByTestId('ws-breadcrumb-name-input');
    await nameInput.fill('Echo');
    await nameInput.press('Enter');
    await expect(breadcrumbName).toHaveText('Echo');

    // One axe pass over the open editor, before the session changes anything on screen.
    const beforeConnect = await new AxeBuilder({ page }).setLegacyMode(true).analyze();
    const seriousBefore = beforeConnect.violations.filter((violation) => GATED_IMPACTS.has(violation.impact ?? ''));
    expect(seriousBefore, JSON.stringify(seriousBefore, null, 2)).toEqual([]);

    // Connect, send `hello`, watch it round-trip.
    await expect(page.getByTestId('ws-connect')).toBeVisible({ timeout: 20_000 });
    await page.getByTestId('ws-connect').click();
    await expect(page.getByTestId('ws-state')).toContainText('open', { timeout: 20_000 });

    await page.getByTestId('ws-composer-text').fill('hello');
    await page.getByTestId('ws-composer-send').click();

    const frames = page.getByTestId('ws-frame-row');
    await expect(frames).toHaveCount(2, { timeout: 20_000 });
    await expect(frames.nth(0)).toContainText('hello');
    await expect(frames.nth(0).getByRole('img', { name: 'Sent' })).toBeVisible();
    await expect(frames.nth(1)).toContainText('hello');
    await expect(frames.nth(1).getByRole('img', { name: 'Received' })).toBeVisible();

    // Disconnect with a chosen code and reason, and read the chip that follows.
    await page.getByRole('button', { name: 'Close code and reason' }).click();
    // Scoped to the popover: other panes label a field "Code" too, and page-wide is ambiguous.
    const closeOptions = page.getByRole('group', { name: 'Close code and reason' });
    await closeOptions.getByLabel('Code').fill('3001');
    await closeOptions.getByLabel('Reason').fill('done');
    await page.getByTestId('ws-connect').click();
    await expect(page.getByTestId('ws-state')).toHaveText('closed 3001', { timeout: 20_000 });

    // The request's own file, on disk, opens as a WebSocket document. Save first: nothing reaches
    // the project folder until it does, and the read below would race the write.
    await saveAll(page);
    const projectDir = workspaceProjectDir(userDataDir!, 'Feeds');
    const apiYaml = readFileSync(join(projectDir, 'apis/Echo API/api.yaml'), 'utf8');
    expect(apiYaml).toContain('kind: websocket');

    // History lists the session.
    await page.getByTestId('activity-bar').getByRole('button', { name: 'History' }).click();
    const historyRows = page.locator('[data-testid="history-row"]');
    await expect(historyRows.filter({ hasText: 'Echo' })).toHaveCount(1, { timeout: 20_000 });

    // The Console's HTTP Log lists one WS row with a 101 status.
    const logRows = page.locator('[data-testid="http-log-row"]').filter({ hasText: 'Echo' });
    await expect(logRows).toHaveCount(1, { timeout: 20_000 });
    await expect(logRows.first().getByTestId('http-log-status')).toContainText('101');
  });
});
