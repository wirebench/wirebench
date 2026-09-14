import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { setMonacoText } from '../helpers/editor.js';
import { killApp, launchApp, removeDirSync, type LaunchedApp } from '../helpers/launch-app.js';
import {
  createProjectWithCalculator,
  createWorkspace,
  expandExplorer,
  openFirstRequest,
  workspaceProjectDir,
} from '../helpers/project.js';
import { startTestSoapServer, type TestSoapServer } from '../helpers/test-server.js';

/** A recognisable value typed into the first request, never saved. */
const MARKER = '424242';

const EDITED_ENVELOPE = [
  '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tem="http://tempuri.org/">',
  '   <soapenv:Header/>',
  '   <soapenv:Body>',
  '      <tem:Add>',
  `         <tem:intA>${MARKER}</tem:intA>`,
  '         <tem:intB>?</tem:intB>',
  '      </tem:Add>',
  '   </soapenv:Body>',
  '</soapenv:Envelope>',
].join('\n');

/** The request editor's text, whitespace removed, as the editor-actions spec reads it. */
async function envelopeText(page: Page): Promise<string> {
  const lines = await page
    .locator('[aria-label="Request envelope XML"]')
    .locator('xpath=ancestor::*[contains(@class, "monaco-editor")][1]')
    .locator('.view-line')
    .allTextContents();
  return lines.join('').replace(/\s| /g, '');
}

/**
 * Whether any file under `dir` contains `needle`.
 *
 * A `<name>.tmp-<hex>` sibling is skipped: that is the temp file every atomic write in the app
 * (project, workspace, and the unsaved store's own records) fills before renaming it over the
 * target, and its bytes are not "on disk" until that rename. Reading it as if they were is how
 * the crash test below used to kill the app between the write and the rename — the poll had seen
 * the marker in the temp file, the real record never got it, and the relaunch had nothing to
 * restore.
 */
function anyFileContains(dir: string, needle: string): boolean {
  for (const name of readdirSync(dir)) {
    if (name.includes('.tmp-')) {
      continue;
    }
    const path = join(dir, name);
    if (statSync(path).isDirectory() ? anyFileContains(path, needle) : readFileSync(path, 'utf8').includes(needle)) {
      return true;
    }
  }
  return false;
}

/** Types the marker into the first request and waits for it to be staged as an unsaved edit. */
async function editFirstRequestWithoutSaving(page: Page): Promise<void> {
  await openFirstRequest(page);
  await setMonacoText(page, 'Request envelope XML', EDITED_ENVELOPE);
  await expect.poll(() => envelopeText(page), { timeout: 15_000 }).toContain(`<tem:intA>${MARKER}</tem:intA>`);
  await expect(page.getByTestId('editor-tab-dirty')).toHaveCount(1, { timeout: 10_000 });
}

/** After a relaunch (or a switch back): the first request shows the marker again, still unsaved. */
async function expectEditRestoredUnsaved(page: Page, userDataDir: string): Promise<void> {
  await expandExplorer(page, 'Request 1');
  await openFirstRequest(page);
  await expect.poll(() => envelopeText(page), { timeout: 20_000 }).toContain(`<tem:intA>${MARKER}</tem:intA>`);
  await expect(page.getByTestId('editor-tab-dirty')).toHaveCount(1, { timeout: 10_000 });
  // Nothing was written to the project itself.
  expect(anyFileContains(workspaceProjectDir(userDataDir), MARKER)).toBe(false);
}

test.describe('unsaved changes across sessions', () => {
  let launched: LaunchedApp | undefined;
  let server: TestSoapServer | undefined;
  let userDataDir = '';

  test.beforeEach(async () => {
    server = await startTestSoapServer({ fixture: 'calculator' });
    userDataDir = mkdtempSync(join(tmpdir(), 'wirebench-e2e-unsaved-'));
  });

  test.afterEach(async () => {
    await launched?.close().catch(() => undefined);
    launched = undefined;
    await server?.close();
    server = undefined;
    removeDirSync(userDataDir);
  });

  test('an unsaved request edit survives quitting, still unsaved and unwritten', async () => {
    launched = await launchApp({ userDataDir, keepUserDataDir: true });
    await createProjectWithCalculator(launched.window, server!);
    await editFirstRequestWithoutSaving(launched.window);

    // Electron's own quit, so the app's before-quit path runs exactly as it does for a user.
    const quitting = launched.app.waitForEvent('close', { timeout: 30_000 });
    await launched.app.evaluate(({ app }) => {
      app.quit();
    });
    await quitting;
    expect(anyFileContains(workspaceProjectDir(userDataDir), MARKER)).toBe(false);

    launched = await launchApp({ userDataDir, keepUserDataDir: true });
    await expectEditRestoredUnsaved(launched.window, userDataDir);
  });

  test('an unsaved request edit survives switching to another workspace and back', async () => {
    launched = await launchApp({ userDataDir, keepUserDataDir: true });
    const page = launched.window;
    await createProjectWithCalculator(page, server!);
    await editFirstRequestWithoutSaving(page);

    await page.getByTestId('workspace-switcher').click();
    await page.getByRole('menuitem', { name: 'Create workspace…' }).click();
    await createWorkspace(page, 'Workspace 2');
    await expect(page.getByTestId('editor-tab-dirty')).toHaveCount(0);

    await page.getByTestId('workspace-switcher').click();
    await page.getByRole('menuitem', { name: /Workspace 1/ }).click();
    await expect(page.getByTestId('title-bar')).toContainText('Workspace 1', { timeout: 20_000 });
    await expectEditRestoredUnsaved(page, userDataDir);
  });

  test('an unsaved request edit survives a crash', async () => {
    launched = await launchApp({ userDataDir, keepUserDataDir: true });
    await createProjectWithCalculator(launched.window, server!);
    await editFirstRequestWithoutSaving(launched.window);

    // Past the renderer's hand-over delay, then no clean exit at all.
    const unsavedDir = join(userDataDir, 'workspaces');
    await expect.poll(() => anyFileContains(unsavedDir, MARKER), { timeout: 15_000, intervals: [250] }).toBe(true);
    const crashed = launched.app;
    launched = undefined;
    await killApp(crashed);

    launched = await launchApp({ userDataDir, keepUserDataDir: true });
    await expectEditRestoredUnsaved(launched.window, userDataDir);
  });
});
