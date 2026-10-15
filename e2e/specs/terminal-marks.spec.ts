import { expect, test, type Page } from '@playwright/test';
import { launchApp, type LaunchedApp } from '../helpers/launch-app.js';
import { createWorkspace } from '../helpers/project.js';

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

let launched: LaunchedApp | undefined;

test.afterEach(async () => {
  await launched?.close();
  launched = undefined;
});

/** Opens a local terminal from the palette and waits until `count` of them run a shell. */
async function newLocalTerminal(page: Page, count: number): Promise<void> {
  await page.keyboard.press(`${MOD}+Shift+P`);
  const input = page.getByTestId('command-palette-input');
  await expect(input).toBeVisible({ timeout: 20_000 });
  await input.fill('New Local Terminal');
  await page
    .getByRole('option', { name: /New Local Terminal/ })
    .first()
    .click();
  await expect(page.getByRole('tab', { name: /Local · / })).toHaveCount(count, { timeout: 30_000 });
  await expect(page.getByTestId('editor-area').getByLabel('connected', { exact: true })).toHaveCount(count, {
    timeout: 30_000,
  });
}

// The commands are POSIX shell; Windows runs PowerShell.
test.skip(process.platform === 'win32', 'POSIX shell commands');

test('a terminal behind another tab is marked for new output, a prompt and an error', async () => {
  test.setTimeout(180_000);
  launched = await launchApp();
  const page = launched.window;
  await createWorkspace(page, 'Marks');

  await newLocalTerminal(page, 1);
  const tabs = page.getByRole('tab', { name: /Local · / });
  const first = tabs.nth(0);
  const mark = first.getByTestId('terminal-mark');
  const shown = page.locator('[data-testid="local-terminal"]:visible');
  await shown.click();
  // Output while the tab is behind, then a password prompt; after the answer, a failing exit.
  // `'Pass''word'` keeps the echoed command line itself from reading as a prompt.
  await page.keyboard.type(
    "sleep 3; echo late-output; sleep 4; printf 'Pass''word: '; read -r answer; sleep 3; exit 4",
  );
  await page.keyboard.press('Enter');

  await newLocalTerminal(page, 2);
  await expect(mark).toHaveAttribute('data-mark', 'unread', { timeout: 30_000 });
  await expect(first.getByRole('img', { name: 'New output' })).toBeVisible();
  await expect(page.getByTestId('terminal-marks-announcer')).toContainText('New output');

  await expect(mark).toHaveAttribute('data-mark', 'input', { timeout: 30_000 });
  await expect(page.getByTestId('terminal-marks-announcer')).toContainText('Waiting for input');

  // Going to the tab clears its mark.
  await first.click();
  await expect(mark).toHaveCount(0);
  await expect(shown).toContainText('late-output');

  // Answer the prompt and leave at once: the exit lands while the tab is behind.
  await shown.click();
  await page.keyboard.type('yes');
  await page.keyboard.press('Enter');
  await tabs.nth(1).click();
  await expect(mark).toHaveAttribute('data-mark', 'error', { timeout: 30_000 });
  await expect(page.getByTestId('terminal-marks-announcer')).toContainText('Error or disconnected');
});
