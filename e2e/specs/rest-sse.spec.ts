import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { launchApp, type LaunchedApp } from '../helpers/launch-app.js';
import { createProject, createWorkspace } from '../helpers/project.js';
import { createApi, createRestRequest, openResponseTab, responseStatus, setMethodAndUrl } from '../helpers/rest.js';
import { startTestRestServer, type TestRestServer } from '../helpers/test-server.js';

/** Axe fails the spec at these impact levels, the same gate `a11y.spec.ts` uses. */
const GATED_IMPACTS = new Set(['serious', 'critical']);

test.describe('REST: an event-stream response arrives live, stops, and is recorded', () => {
  let launched: LaunchedApp | undefined;
  let server: TestRestServer | undefined;
  let userDataDir: string | undefined;

  test.beforeEach(async () => {
    server = await startTestRestServer();
    userDataDir = mkdtempSync(join(tmpdir(), 'wirebench-sse-'));
    launched = await launchApp({ userDataDir });
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

  test('rows arrive while open, Stop ends it cleanly, and it shows up in History and the Console', async () => {
    const page = launched!.window;
    await createWorkspace(page, 'SSE');
    await createProject(page, 'Streams');
    await createApi(page, 'Streamer', server!.url);
    await createRestRequest(page, 'Streamer', 'Forever');
    await setMethodAndUrl(page, 'GET', '/sse/forever?events=1');

    // Send: the stream never ends on its own (an event every 50 ms), so the button reads *Stop*
    // for as long as it is open.
    await page.getByTestId('rest-send').click();
    await expect(responseStatus(page)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('rest-send')).toHaveText('Stop', { timeout: 20_000 });

    // The Events tab, opened while the stream is still open, gains at least two rows.
    await openResponseTab(page, 'Events');
    const events = page.getByTestId('sse-events');
    await expect(events).toBeVisible({ timeout: 20_000 });

    // One axe pass over the Events tab while it is live, before anything is stopped.
    const results = await new AxeBuilder({ page }).setLegacyMode(true).analyze();
    const serious = results.violations.filter((violation) => GATED_IMPACTS.has(violation.impact ?? ''));
    expect(serious, JSON.stringify(serious, null, 2)).toEqual([]);

    const rows = page.getByTestId('sse-row');
    await expect(rows.nth(1)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('rest-send')).toHaveText('Stop');

    // A real event row: its name, its id and its data, not only the stream's comments.
    const firstEvent = rows.filter({ hasText: '{"tick":1}' }).first();
    await expect(firstEvent).toBeVisible({ timeout: 20_000 });
    await expect(firstEvent.getByTestId('sse-row-chip')).toHaveText('message');
    await expect(firstEvent).toContainText('1');

    // Stop: a normal completion, never an error. The status line reads "stopped", not a failure.
    await page.getByTestId('rest-send').click();
    await expect(page.getByTestId('rest-send')).toHaveText('Send', { timeout: 20_000 });
    await expect(responseStatus(page)).toContainText('stopped', { timeout: 20_000 });

    // History lists the entry.
    await page.getByTestId('activity-bar').getByRole('button', { name: 'History' }).click();
    const historyRows = page.locator('[data-testid="history-row"]');
    await expect(historyRows.filter({ hasText: 'Forever' })).toHaveCount(1, { timeout: 20_000 });

    // The Console's HTTP Log row names the request and reads its true event count.
    const logRow = page.locator('[data-testid="http-log-row"]').filter({ hasText: 'Forever' });
    await expect(logRow).toHaveCount(1, { timeout: 20_000 });
    // At least the two events seen before Stop: a stream of comments alone would read "0 events".
    await expect(logRow.first()).toContainText(/·\s*([2-9]|\d{2,})\s*events/);
  });
});
