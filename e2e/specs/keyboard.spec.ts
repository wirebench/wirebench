import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { launchApp, type LaunchedApp } from '../helpers/launch-app.js';
import { createProjectWithCalculator, expectReopenedWorkspace, openFirstRequest } from '../helpers/project.js';
import { startTestSoapServer, type TestSoapServer } from '../helpers/test-server.js';

/** The platform's `Mod`: ⌘ on macOS, Ctrl elsewhere — the same split `lib/keybindings.ts` makes. */
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

/** Opens Settings → Shortcuts and returns the chord button for `command`. */
async function shortcutButton(page: Page, command: string) {
  await page.keyboard.press(`${MOD}+Comma`);
  await expect(page.getByTestId('preferences-editor')).toBeVisible({ timeout: 20_000 });
  await page.getByTestId('preferences-editor').getByRole('button', { name: 'Shortcuts', exact: true }).click();
  await expect(page.getByTestId('shortcuts-table')).toBeVisible();
  return page.locator(`[data-testid="shortcut-row"][data-command="${command}"] [data-testid="shortcut-chord"]`);
}

/** Closes the Settings dialog — it is modal, so nothing behind it is reachable until it goes. */
async function closeSettings(page: Page) {
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('preferences-dialog')).toHaveCount(0);
}

test.describe('keyboard', () => {
  let launched: LaunchedApp | undefined;
  let server: TestSoapServer | undefined;
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
    if (userDataDir.length > 0) {
      rmSync(userDataDir, { recursive: true, force: true });
    }
    userDataDir = '';
  });

  test('imports, opens and sends a request without touching the mouse', async () => {
    launched = await launchApp({ userDataDir, keepUserDataDir: true });
    const page = launched.window;

    // The picker's name field is focused on load — the workspace, the project and everything
    // after it is keys only, with no native picker anywhere in the flow.
    await expect(page.getByTestId('workspace-create-name')).toBeFocused();
    await page.keyboard.type('Keyboard');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('title-bar')).toContainText('Keyboard');

    // ⌘⇧N — New Project — which asks for a name and nothing else.
    await page.keyboard.press(`${MOD}+Shift+KeyN`);
    await expect(page.getByTestId('new-project-name')).toBeFocused({ timeout: 20_000 });
    await page.keyboard.type('Keyboard Project');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('explorer-project-row').filter({ hasText: 'Keyboard Project' })).toBeVisible({
      timeout: 20_000,
    });

    // ⌘⇧P — the palette's second chord — then run Import WSDL from it.
    await page.keyboard.press(`${MOD}+Shift+P`);
    await expect(page.getByTestId('command-palette-input')).toBeVisible({ timeout: 20_000 });
    await page.keyboard.type('Import WSDL');
    await page.keyboard.press('Enter');

    const urlInput = page.getByTestId('import-url-input');
    await expect(urlInput).toBeVisible();
    await page.keyboard.type(server!.wsdlUrl);
    await page.keyboard.press('Enter');

    await expect(page.locator('[data-testid="explorer-tree-row"]', { hasText: 'Request 1' }).first()).toBeVisible({
      timeout: 20_000,
    });

    // ⌘P quick-open, filtered to the Add operation's request.
    await page.keyboard.press(`${MOD}+KeyP`);
    await expect(page.getByTestId('quick-open-input')).toBeVisible({ timeout: 20_000 });
    await page.keyboard.type('Add');
    await expect(page.getByTestId('quick-open-item').first()).toBeVisible();
    await page.keyboard.press('Enter');

    await expect(page.getByTestId('request-editor')).toBeVisible({ timeout: 20_000 });

    // ⌘⏎ sends it.
    await page.keyboard.press(`${MOD}+Enter`);
    await expect(page.getByTestId('response-status')).toContainText(/200/, { timeout: 20_000 });
    await expect(page.getByTestId('response-editor')).toContainText('AddResult');
  });

  test('creates a second workspace and switches back, from the palette alone', async () => {
    launched = await launchApp({ userDataDir, keepUserDataDir: true });
    const page = launched.window;

    await expect(page.getByTestId('workspace-create-name')).toBeFocused();
    await page.keyboard.type('Alpha');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('workspace-switcher')).toHaveText(/Alpha/, { timeout: 20_000 });

    // Create Workspace… from the palette: the new one opens, which closes Alpha.
    await page.keyboard.press(`${MOD}+Shift+P`);
    await expect(page.getByTestId('command-palette-input')).toBeVisible({ timeout: 20_000 });
    await page.keyboard.type('Create Workspace');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('workspace-create-name')).toBeFocused({ timeout: 20_000 });
    await page.keyboard.type('Beta');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('workspace-switcher')).toHaveText(/Beta/, { timeout: 20_000 });

    // Switch Workspace… opens the title bar's dropdown with the keyboard already in it.
    await page.keyboard.press(`${MOD}+Shift+P`);
    await expect(page.getByTestId('command-palette-input')).toBeVisible({ timeout: 20_000 });
    await page.keyboard.type('Switch Workspace');
    await page.keyboard.press('Enter');
    const alpha = page.getByTestId('workspace-switcher-item').filter({ hasText: 'Alpha' });
    await expect(alpha).toBeVisible({ timeout: 20_000 });
    // Enter on the row, with no pointer anywhere near it: the menu is operable by key alone.
    await alpha.press('Enter');

    await expect(page.getByTestId('workspace-switcher')).toHaveText(/Alpha/, { timeout: 20_000 });
  });

  test('a rebound Send survives a relaunch, and the old chord no longer sends', async () => {
    launched = await launchApp({ userDataDir, keepUserDataDir: true });
    let page = launched.window;
    await createProjectWithCalculator(page, server!);

    // --- rebind request.send to ⌘⇧⏎ -----------------------------------------
    const chord = await shortcutButton(page, 'request.send');
    await expect(chord).toContainText(process.platform === 'darwin' ? '⌘⏎' : 'Ctrl+Enter');
    await chord.click();
    await expect(chord).toHaveText('Press a key…');
    await page.keyboard.press(`${MOD}+Shift+Enter`);
    await expect(chord).not.toHaveText('Press a key…');
    await closeSettings(page);

    // --- relaunch against the same profile ------------------------------------
    await launched.close();
    launched = await launchApp({ userDataDir, keepUserDataDir: true });
    page = launched.window;
    // A relaunch reopens the last workspace and its project by itself.
    await expectReopenedWorkspace(page);

    const persisted = await shortcutButton(page, 'request.send');
    await expect(persisted).toContainText(process.platform === 'darwin' ? '⌘⇧⏎' : 'Ctrl+Shift+Enter');

    // --- the old chord is dead, the new one sends -----------------------------
    await closeSettings(page);
    // ⌘, no longer touches the sidebar, but the explorer is asserted rather than assumed: the
    // view this workspace reopens with is whatever the last session left it on.
    await page.keyboard.press(`${MOD}+Shift+E`);
    await openFirstRequest(page);
    const status = page.getByTestId('response-status');
    await page.keyboard.press(`${MOD}+Enter`);
    // Nothing to wait *for*, so wait a beat and assert the absence: no status ever appeared.
    await page.waitForTimeout(1_000);
    await expect(status).toHaveCount(0);

    await page.keyboard.press(`${MOD}+Shift+Enter`);
    await expect(status).toContainText(/200/, { timeout: 20_000 });
  });

  test('⌥→ steps the caret through element values and ⇧Tab crosses to the response', async () => {
    launched = await launchApp({ userDataDir, keepUserDataDir: true });
    const page = launched.window;
    await createProjectWithCalculator(page, server!);
    await openFirstRequest(page);

    const editor = page.locator('[aria-label="Request envelope XML"]');
    const widget = editor.locator('xpath=ancestor::*[contains(@class, "monaco-editor")][1]');
    await expect(widget).toBeVisible({ timeout: 20_000 });
    await widget.click({ position: { x: 8, y: 8 } });

    // ⌥→ lands on an element value, so typing replaces that value rather than inserting text
    // wherever the caret happened to be.
    await page.keyboard.press('Alt+ArrowRight');
    await page.keyboard.type('11');
    await expect
      .poll(async () => (await widget.locator('.view-line').allTextContents()).join('\n'), { timeout: 10_000 })
      .toContain('11');

    // ⇧Tab crosses to the response pane once there is one to cross to.
    await page.keyboard.press(`${MOD}+Enter`);
    await expect(page.getByTestId('response-status')).toContainText(/200/, { timeout: 20_000 });
    // Put the caret back in the request editor first: the send and the response render both
    // move focus, and ⇧Tab is about crossing *from* one pane *to* the other.
    await widget.click({ position: { x: 8, y: 8 } });
    await page.keyboard.press('Shift+Tab');
    // Monaco's `aria-label` sits on its edit-context host — the element that actually takes
    // focus — so this is the honest "the caret is now in the response editor" assertion.
    await expect(page.locator('[aria-label="Response envelope XML"]')).toBeFocused({ timeout: 10_000 });

    // …and back again: it is a toggle, not a one-way trip.
    await page.keyboard.press('Shift+Tab');
    await expect(editor).toBeFocused({ timeout: 10_000 });
  });

  test('the Search view finds a definition operation and opens it', async () => {
    launched = await launchApp({ userDataDir, keepUserDataDir: true });
    const page = launched.window;
    await createProjectWithCalculator(page, server!);

    await page.keyboard.press(`${MOD}+Shift+S`);
    const input = page.getByTestId('search-input');
    await expect(input).toBeVisible({ timeout: 20_000 });
    await input.fill('Subtract');

    const results = page.getByTestId('search-result');
    await expect(results.first()).toBeVisible({ timeout: 20_000 });
    await results.first().click();

    // Whatever matched first — a request envelope or the WSDL — an editor tab is now open on it.
    await expect(page.getByTestId('editor-area')).toBeVisible();
  });
});
