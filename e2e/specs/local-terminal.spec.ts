import { expect, test, type Page } from '@playwright/test';
import { launchApp, type LaunchedApp } from '../helpers/launch-app.js';
import { createWorkspace } from '../helpers/project.js';

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';
/**
 * A command whose output is not in what was typed, so finding it proves the shell ran it: the login shell on
 * macOS and Linux, PowerShell on Windows.
 */
const COMPUTE = process.platform === 'win32' ? '6007*7' : 'echo $((6007*7))';
const RESULT = '42049';

let launched: LaunchedApp | undefined;

test.afterEach(async () => {
  await launched?.close();
  launched = undefined;
});

/** Opens the command palette and types `query`, leaving it open. */
async function searchPalette(page: Page, query: string): Promise<void> {
  await page.keyboard.press(`${MOD}+Shift+P`);
  const input = page.getByTestId('command-palette-input');
  await expect(input).toBeVisible({ timeout: 20_000 });
  await input.fill(query);
}

test('a local terminal runs a command in this machine’s shell, and ends with it', async () => {
  test.setTimeout(120_000);
  launched = await launchApp();
  const page = launched.window;
  await createWorkspace(page, 'Local');

  await page.getByTestId('activity-hosts').click();
  await page.getByTestId('ssh-new-local-terminal').click();
  const terminal = page.getByTestId('local-terminal');
  await expect(terminal.locator('.xterm')).toBeVisible({ timeout: 30_000 });
  // Keys typed before the shell starts go nowhere: wait for the tab's dot to say it runs.
  await expect(page.getByTestId('editor-area').getByLabel('connected', { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByRole('tab', { name: /Local · / })).toBeVisible();
  await terminal.click();
  await page.keyboard.type(COMPUTE);
  await page.keyboard.press('Enter');
  await expect(terminal).toContainText(RESULT, { timeout: 60_000 });

  await page.keyboard.type('exit 3');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('local-terminal-notice')).toContainText('Shell ended (code 3)', { timeout: 30_000 });

  // Restart starts a new shell in the same tab.
  await page.getByTestId('local-terminal-notice').getByRole('button', { name: 'Restart' }).click();
  await expect(page.getByTestId('local-terminal-notice')).toBeHidden();
  await expect(page.getByTestId('editor-area').getByLabel('connected', { exact: true })).toBeVisible({
    timeout: 30_000,
  });

  // The palette has the command too.
  await searchPalette(page, 'New Local Terminal');
  await expect(page.getByRole('option', { name: /New Local Terminal/ }).first()).toBeVisible();
  await page.keyboard.press('Escape');
});

test('WIREBENCH_AREAS=local-terminal=off removes the local terminal and keeps SSH', async () => {
  launched = await launchApp({ extraEnv: { WIREBENCH_AREAS: 'local-terminal=off' } });
  const page = launched.window;
  await createWorkspace(page, 'Quiet');
  await page.getByTestId('activity-hosts').click();
  await expect(page.getByTestId('ssh-nav-hosts')).toBeVisible();
  await expect(page.getByTestId('ssh-new-local-terminal')).toHaveCount(0);

  await searchPalette(page, 'New Local Terminal');
  await expect(page.getByText('No matching command.')).toBeVisible();
  await expect(page.getByRole('option', { name: /New Local Terminal/ })).toHaveCount(0);
  await page.keyboard.press('Escape');
});
