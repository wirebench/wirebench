import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { runCommand } from '../helpers/palette.js';
import { launchApp, type LaunchedApp } from '../helpers/launch-app.js';
import {
  createProjectWithCalculator,
  createWorkspace,
  expectReopenedWorkspace,
  openFirstRequest,
} from '../helpers/project.js';
import { startTestSoapServer, type TestSoapServer } from '../helpers/test-server.js';
import { selectTab } from '../helpers/tabs.js';

/** `--wb-bg-base` per colour theme and mode, as `tokens.css` sets it, in the rgb form `getComputedStyle` reports. */
const BG_BASE = {
  /** Default light, `#faf9f7`: what main shows today. */
  defaultLight: 'rgb(250, 249, 247)',
  /** Sandstone light, `#fbf7f3`. */
  sandstoneLight: 'rgb(251, 247, 243)',
  /** Sandstone dark, `#1c1714`. */
  sandstoneDark: 'rgb(28, 23, 20)',
} as const;

/** `<html>`'s colour theme and mode, and `body`'s computed background, read once. */
async function shellColours(page: Page): Promise<{ palette: string | null; theme: string | null; body: string }> {
  return page.evaluate(() => ({
    palette: document.documentElement.getAttribute('data-palette'),
    theme: document.documentElement.getAttribute('data-theme'),
    body: getComputedStyle(document.body).backgroundColor,
  }));
}

/**
 * The request envelope editor's computed background. Monaco has no public getter for the active
 * theme's name, so this reads what the theme paints instead: every `wirebench-<palette>-<mode>`
 * theme sets `editor.background` to that palette's `--wb-bg-base`.
 */
function envelopeEditor(page: Page): Locator {
  return page
    .locator('[aria-label="Request envelope XML"]')
    .locator('xpath=ancestor::*[contains(@class, "monaco-editor")][1]');
}

async function backgroundOf(target: Locator): Promise<string> {
  return target.evaluate((element) => getComputedStyle(element).backgroundColor);
}

/** Opens Settings → Appearance with ⌘, / Ctrl+,. */
async function openAppearance(page: Page): Promise<void> {
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Comma' : 'Control+Comma');
  await expect(page.getByTestId('preferences-editor')).toBeVisible({ timeout: 20_000 });
  await page.getByTestId('preferences-editor').getByRole('button', { name: 'Appearance', exact: true }).click();
  await expect(page.getByTestId('preferences-palette')).toBeVisible({ timeout: 10_000 });
}

/** Leaves Settings with Escape. */
async function closeSettings(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('settings-page')).toHaveCount(0);
}

/** Opens the colour theme picker through its command. */
async function openColourThemePicker(page: Page): Promise<void> {
  await runCommand(page, 'Theme: choose colour theme');
  await expect(page.getByTestId('quick-open-input')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('[data-testid="palette-colour-theme"]')).toHaveCount(8);
}

test.describe('request properties and preferences', () => {
  let launched: LaunchedApp | undefined;
  let server: TestSoapServer | undefined;
  // Assigned in `beforeEach`; kept non-optional so `launchApp` (under
  // `exactOptionalPropertyTypes`) does not have to be handed `string | undefined`.
  let userDataDir = '';

  test.beforeEach(async () => {
    server = await startTestSoapServer({ fixture: 'calculator', respondToCalculatorAdd: true });
    userDataDir = mkdtempSync(join(tmpdir(), 'wirebench-e2e-profile-'));
  });

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
      if (dir.length > 0) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
    userDataDir = '';
  });

  test('a 100 ms request timeout beats a 500 ms endpoint, and is reported as a timeout', async () => {
    launched = await launchApp({ userDataDir, keepUserDataDir: true });
    const page = launched.window;
    await createProjectWithCalculator(page, server!);
    await openFirstRequest(page);

    await selectTab(page, 'Request tabs', 'Properties');
    const timeout = page.getByTestId('request-timeout');
    await expect(timeout).toBeVisible({ timeout: 20_000 });
    await timeout.fill('100');
    await timeout.press('Enter');

    // Point the request at a route that answers half a second later than that.
    await page.getByTestId('request-endpoint').fill(`${server!.url}/delay/500`);

    await page.getByTestId('request-send').click();

    await expect(page.getByTestId('response-status')).toContainText('timeout', {
      ignoreCase: true,
      timeout: 20_000,
    });

    // …and it is not a Problem: the network failed, nothing in the project is wrong (#635).
    await page.getByRole('tab', { name: /Problems/ }).click();
    await expect(page.getByTestId('problem-row').filter({ hasText: /timed? ?out/i })).toHaveCount(0);
  });

  test('the Appearance tab size drives a recreated envelope, and its theme drives the shell', async () => {
    launched = await launchApp({ userDataDir, keepUserDataDir: true });
    const page = launched.window;
    await createProjectWithCalculator(page, server!);
    await openFirstRequest(page);

    // ⌘, / Ctrl+, opens the Settings page, on Appearance.
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Comma' : 'Control+Comma');
    await expect(page.getByTestId('preferences-editor')).toBeVisible({ timeout: 20_000 });

    await page.getByTestId('preferences-editor').getByRole('button', { name: 'Appearance', exact: true }).click();
    const tabSize = page.getByTestId('preferences-tab-size');
    await tabSize.fill('2');
    await tabSize.press('Enter');

    // --- the theme, from the same section -------------------------------------
    await page.getByTestId('preferences-theme-light').click();
    await expect(page.getByTestId('preferences-theme-light')).toHaveAttribute('aria-checked', 'true');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light', { timeout: 10_000 });

    // Settings takes the whole window while open: leave it before touching the editor.
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('settings-page')).toHaveCount(0);

    // --- back to the request, and recreate it with the new indent -------------
    await page.getByRole('tab', { name: 'Add (SOAP 1.1)' }).click();
    // Recreate is not in the request pane's right-click menu; the palette reaches it.
    await runCommand(page, 'Request: Recreate (keep values)');

    await expect
      .poll(
        async () => {
          const lines = await page
            .locator('[aria-label="Request envelope XML"]')
            .locator('xpath=ancestor::*[contains(@class, "monaco-editor")][1]')
            .locator('.view-line')
            .allTextContents();
          // Monaco renders leading indentation as non-breaking spaces; normalise them so the
          // assertion is about the *number* of spaces, not their encoding.
          return lines.map((line) => line.replace(/ /g, ' '));
        },
        { timeout: 20_000 },
      )
      // Two spaces before `<soapenv:Header`, and never the three the default indent produces.
      .toEqual(expect.arrayContaining([expect.stringMatching(/^ {2}<soapenv:Header/)]));
  });

  test('a colour theme and its mode apply to the shell and Monaco, survive a relaunch, and preview in the picker', async () => {
    launched = await launchApp({ userDataDir, keepUserDataDir: true });
    let page = launched.window;
    // A request open, so there is a Monaco editor whose theme can be checked.
    await createProjectWithCalculator(page, server!);
    await openFirstRequest(page);
    await expect(envelopeEditor(page)).toBeVisible({ timeout: 20_000 });

    // --- Settings → Appearance: Sandstone, then Light -----------------------------
    await openAppearance(page);
    await page.getByTestId('preferences-palette-sandstone').click();
    await expect(page.getByTestId('preferences-palette-sandstone')).toHaveAttribute('aria-checked', 'true');
    await page.getByTestId('preferences-theme-light').click();
    await expect(page.getByTestId('preferences-theme-light')).toHaveAttribute('aria-checked', 'true');

    const html = page.locator('html');
    await expect(html).toHaveAttribute('data-palette', 'sandstone', { timeout: 10_000 });
    await expect(html).toHaveAttribute('data-theme', 'light', { timeout: 10_000 });
    await expect.poll(async () => (await shellColours(page)).body).toBe(BG_BASE.sandstoneLight);
    await closeSettings(page);

    // --- the status bar cycles the mode, and Monaco follows -------------------------
    const status = page.getByTestId('status-bar-theme');
    await expect(status).toHaveAttribute('data-colour-theme', 'sandstone');
    await expect(status).toHaveAttribute('aria-label', 'Theme: Sandstone · Light. Cycle mode');
    await expect.poll(() => backgroundOf(envelopeEditor(page)), { timeout: 10_000 }).toBe(BG_BASE.sandstoneLight);

    // dark → light → system: from Light, two clicks reach Dark (System's resolution depends on the OS).
    await status.click();
    await expect(status).toHaveAttribute('data-theme-preference', 'system');
    await status.click();
    await expect(status).toHaveAttribute('data-theme-preference', 'dark');
    await expect(html).toHaveAttribute('data-theme', 'dark', { timeout: 10_000 });
    await expect(html).toHaveAttribute('data-palette', 'sandstone');
    await expect.poll(() => backgroundOf(envelopeEditor(page)), { timeout: 10_000 }).toBe(BG_BASE.sandstoneDark);

    // …and back to Light, the mode the relaunch should come back in.
    await status.click();
    await expect(status).toHaveAttribute('data-theme-preference', 'light');
    await expect(html).toHaveAttribute('data-theme', 'light', { timeout: 10_000 });
    await expect.poll(() => backgroundOf(envelopeEditor(page)), { timeout: 10_000 }).toBe(BG_BASE.sandstoneLight);

    // --- relaunch: the first check after the window shows already has it -------------
    await launched.close();
    launched = await launchApp({ userDataDir, keepUserDataDir: true });
    page = launched.window;
    // Read once, without retrying: the colour theme is applied before the first paint.
    expect(await shellColours(page)).toEqual({ palette: 'sandstone', theme: 'light', body: BG_BASE.sandstoneLight });
    await expectReopenedWorkspace(page);

    // --- the picker: arrows preview, Escape puts back what was chosen -----------------
    await openColourThemePicker(page);
    const current = page.locator('[data-testid="palette-colour-theme"][data-current="true"]');
    await expect(current).toHaveAttribute('data-colour-theme', 'sandstone');
    // Sandstone, Dusk, …: one step down is Dusk.
    await page.keyboard.press('ArrowDown');
    await expect(page.locator('html')).toHaveAttribute('data-palette', 'dusk', { timeout: 10_000 });
    await page.keyboard.press('ArrowDown');
    await expect(page.locator('html')).not.toHaveAttribute('data-palette', 'dusk', { timeout: 10_000 });
    await page.keyboard.press('ArrowUp');
    await expect(page.locator('html')).toHaveAttribute('data-palette', 'dusk', { timeout: 10_000 });
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('quick-open-input')).toHaveCount(0);
    await expect(page.locator('html')).toHaveAttribute('data-palette', 'sandstone', { timeout: 10_000 });
    await expect.poll(async () => (await shellColours(page)).body).toBe(BG_BASE.sandstoneLight);
    await expect(page.getByTestId('status-bar-theme')).toHaveAttribute('data-colour-theme', 'sandstone');

    // --- …and Enter keeps the one under the highlight ----------------------------------
    await openColourThemePicker(page);
    await page.keyboard.press('ArrowDown');
    await expect(page.locator('html')).toHaveAttribute('data-palette', 'dusk', { timeout: 10_000 });
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('quick-open-input')).toHaveCount(0);
    await expect(page.locator('html')).toHaveAttribute('data-palette', 'dusk');
    await expect(page.getByTestId('status-bar-theme')).toHaveAttribute('data-colour-theme', 'dusk');
    // Chosen, not previewed: the picker reopens with Dusk as the current one, and Settings agrees.
    await openColourThemePicker(page);
    await expect(current).toHaveAttribute('data-colour-theme', 'dusk');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('quick-open-input')).toHaveCount(0);
    await expect(page.locator('html')).toHaveAttribute('data-palette', 'dusk');

    // --- Default takes the attribute away, and the shell is main's again --------------
    await openAppearance(page);
    await expect(page.getByTestId('preferences-palette-dusk')).toHaveAttribute('aria-checked', 'true');
    await page.getByTestId('preferences-palette-default').click();
    await expect(page.getByTestId('preferences-palette-default')).toHaveAttribute('aria-checked', 'true');
    await expect(page.locator('html')).not.toHaveAttribute('data-palette', { timeout: 10_000 });
    await expect
      .poll(async () => shellColours(page))
      .toEqual({
        palette: null,
        theme: 'light',
        body: BG_BASE.defaultLight,
      });
    await closeSettings(page);
  });

  test('Escape leaves Settings opened from the rail button, with the focus still on it (G06)', async () => {
    launched = await launchApp({ userDataDir, keepUserDataDir: true });
    const page = launched.window;
    // The activity bar, and its Settings button, belong to an open workspace.
    await createWorkspace(page);

    // The click leaves the focus, and the button's tooltip, on the rail button.
    await page.getByTestId('activity-settings').click();
    await expect(page.getByTestId('preferences-editor')).toBeVisible({ timeout: 20_000 });

    await page.keyboard.press('Escape');
    await expect(page.getByTestId('settings-page')).toHaveCount(0);
  });
});
