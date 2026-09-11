import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { launchApp, type LaunchedApp } from '../helpers/launch-app.js';
import { createProjectWithCalculator, expectReopenedWorkspace, openFirstRequest } from '../helpers/project.js';
import { startTestSoapServer, type TestSoapServer } from '../helpers/test-server.js';

test.describe('history', () => {
  let launched: LaunchedApp | undefined;
  let server: TestSoapServer | undefined;
  let userDataDir: string | undefined;

  test.afterEach(async () => {
    if (launched) {
      await launched.close();
      launched = undefined;
    }
    if (server) {
      await server.close();
      server = undefined;
    }
    for (const dir of [userDataDir]) {
      if (dir !== undefined) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
    userDataDir = undefined;
  });

  test('records every send, survives a relaunch, re-sends, and diffs two entries', async () => {
    server = await startTestSoapServer({ fixture: 'calculator', respondToCalculatorAdd: true });
    userDataDir = mkdtempSync(join(tmpdir(), 'wirebench-e2e-profile-'));

    // --- first launch: create + import, then send Request 1 twice ------------
    launched = await launchApp({ userDataDir, keepUserDataDir: true });
    await createProjectWithCalculator(launched.window, server, { expectProjectName: 'History Project' });
    await openFirstRequest(launched.window);

    await launched.window.getByTestId('request-send').click();
    await expect(launched.window.getByTestId('response-status')).toContainText(/200/, { timeout: 10_000 });
    await launched.window.getByTestId('request-send').click();
    await expect(launched.window.getByTestId('response-status')).toContainText(/200/, { timeout: 10_000 });

    await launched.window.getByTestId('activity-bar').getByRole('button', { name: 'History' }).click();
    const rows = launched.window.locator('[data-testid="history-row"]');
    await expect(rows).toHaveCount(2, { timeout: 10_000 });
    await expect(rows.first()).toContainText('200');
    await expect(rows.nth(1)).toContainText('200');

    await launched.close();
    launched = undefined;

    // --- second launch: the workspace reopens itself, history survived the relaunch ----
    launched = await launchApp({ userDataDir, keepUserDataDir: true });
    await expectReopenedWorkspace(launched.window);

    // The sidebar's view/visibility is persisted across relaunches, so it may already be
    // showing History from before — only click the activity-bar button if it isn't, since a
    // second click on an already-active view collapses the sidebar instead.
    const historySidebar = launched.window.locator('[data-testid="sidebar"][aria-label="History"]');
    if (!(await historySidebar.isVisible().catch(() => false))) {
      await launched.window.getByTestId('activity-bar').getByRole('button', { name: 'History' }).click();
    }
    const reopenedRows = launched.window.locator('[data-testid="history-row"]');
    await expect(reopenedRows).toHaveCount(2, { timeout: 10_000 });

    // --- Re-send produces a third entry ---------------------------------------
    await launched.window.locator('button[title="Re-send"]').first().click();
    await expect(reopenedRows).toHaveCount(3, { timeout: 10_000 });

    // --- Compare the first two rows opens a diff tab with both labels ---------
    const compareButtons = launched.window.locator('button[title="Compare…"]');
    await compareButtons.nth(0).click();
    await compareButtons.nth(1).click();

    const diffTab = launched.window.locator('[role="tab"]', { hasText: 'Compare' });
    await expect(diffTab).toBeVisible({ timeout: 10_000 });
    // The diff view's header names both compared entries.
    await expect(launched.window.getByText('Request 1', { exact: false }).first()).toBeVisible({ timeout: 10_000 });
  });
});
