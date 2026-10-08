/**
 * Several workspaces open at once, one per window (#72, multi-window design).
 *
 * One test: a second window opens at the picker, is refused the workspace the first window holds,
 * opens its own, and the two stay apart — titles, explorers — until the second window closes and
 * the first carries on untouched.
 */
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { runCommand } from '../helpers/palette.js';
import { launchApp, SHELL_READY_SELECTOR, type LaunchedApp } from '../helpers/launch-app.js';
import { createProject, createWorkspace, expectProjectCount } from '../helpers/project.js';

/** Every window's OS title, sorted: what the dock and the window switcher show. */
async function windowTitles(app: ElectronApplication): Promise<string[]> {
  return await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .map((window) => window.getTitle())
      .sort(),
  );
}

/** Runs New Window from `page` and returns the window it opened, once its shell is up. */
async function openNewWindow(app: ElectronApplication, page: Page): Promise<Page> {
  const opened = app.waitForEvent('window');
  await runCommand(page, 'New Window');
  const second = await opened;
  await second.waitForSelector(SHELL_READY_SELECTOR);
  return second;
}

test.describe('multi-window', () => {
  let launched: LaunchedApp | undefined;

  test.afterEach(async () => {
    if (launched) {
      await launched.close();
      launched = undefined;
    }
  });

  test('a second window holds its own workspace, and closing it leaves the first alone', async () => {
    launched = await launchApp();
    const { app, window: first } = launched;
    await createWorkspace(first, 'Alpha');
    await createProject(first, 'Alpha API');

    const second = await openNewWindow(app, first);
    await expect(second.getByTestId('workspace-picker')).toBeVisible();

    // Alpha is the first window's: the second is refused it and stays at the picker.
    await second.getByTestId('workspace-picker-row').filter({ hasText: 'Alpha' }).click();
    await expect(second.getByTestId('toast-viewport')).toContainText('That workspace is open in another window.');
    await expect(second.getByTestId('workspace-picker')).toBeVisible();

    await createWorkspace(second, 'Beta');
    await expect(first.getByTestId('title-bar')).toContainText('Alpha');
    await expect(second.getByTestId('title-bar')).toContainText('Beta');
    expect(await windowTitles(app)).toEqual(['Alpha — Wirebench', 'Beta — Wirebench']);

    // A project made in one window's workspace is not in the other's.
    await createProject(second, 'Beta API');
    await expectProjectCount(second, 1);
    await expect(second.getByTestId('explorer-project-row').filter({ hasText: 'Alpha API' })).toHaveCount(0);
    await expectProjectCount(first, 1);
    await expect(first.getByTestId('explorer-project-row').filter({ hasText: 'Beta API' })).toHaveCount(0);

    const closed = second.waitForEvent('close');
    await second.evaluate(() => {
      window.close();
    });
    await closed;
    await expect.poll(async () => await windowTitles(app)).toEqual(['Alpha — Wirebench']);
    await expect(first.getByTestId('title-bar')).toContainText('Alpha');
    await expectProjectCount(first, 1);
  });
});
