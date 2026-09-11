import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { launchApp, type LaunchedApp } from '../helpers/launch-app.js';
import { setMonacoText } from '../helpers/editor.js';
import { createProjectWithCalculator } from '../helpers/project.js';
import { startTestSoapServer, type TestSoapServer } from '../helpers/test-server.js';

/**
 * Update Definition end to end, over the crafted `versioned` fixture pair: v1 is imported from
 * one test server, v2 served from a second one is what the interface is updated to. Both
 * fixtures are single documents, which is what lets the test server serve either (it only ever
 * serves a fixture's root WSDL).
 */

/** Echo's request, edited so the merge has a value it must keep. */
const EDITED_ECHO = [
  '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ver="urn:wb:versioned">',
  '   <soapenv:Header/>',
  '   <soapenv:Body>',
  '      <ver:Echo>',
  '         <ver:text>WB-EDIT</ver:text>',
  '      </ver:Echo>',
  '   </soapenv:Body>',
  '</soapenv:Envelope>',
].join('\n');

/** Every `.view-line` of the request editor, whitespace removed — Monaco pads and wraps. */
async function envelopeText(page: Page): Promise<string> {
  const lines = await page
    .locator('[aria-label="Request envelope XML"]')
    .locator('xpath=ancestor::*[contains(@class, "monaco-editor")][1]')
    .locator('.view-line')
    .allTextContents();
  return lines.join('').replace(/\s| /g, '');
}

/** Opens the nth `Request 1` row (operations are alphabetical: Add, Echo, Legacy). */
async function openRequest(page: Page, index: number): Promise<void> {
  const row = page.locator('[data-testid="explorer-tree-row"]', { hasText: 'Request 1' }).nth(index);
  await expect(row).toBeVisible({ timeout: 20_000 });
  await row.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Open', exact: true }).click();
  await expect(page.getByTestId('request-editor')).toBeVisible({ timeout: 20_000 });
}

/** Picks one item off the interface row's context menu. */
async function interfaceMenu(page: Page, item: string): Promise<void> {
  const row = page.locator('[data-testid="explorer-tree-row"]', { hasText: 'VersionedService' }).first();
  await expect(row).toBeVisible({ timeout: 20_000 });
  await row.click({ button: 'right' });
  await page.getByRole('menuitem', { name: item }).click();
}

/** Every file under `dir` whose name ends with `suffix`, found by walking the folder. */
function filesEndingWith(dir: string, suffix: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...filesEndingWith(path, suffix));
    } else if (entry.name.endsWith(suffix)) {
      found.push(path);
    }
  }
  return found;
}

/** Whether any file under `dir` ending in `suffix` contains `needle`. */
function anyFileContains(dir: string, suffix: string, needle: string): boolean {
  return filesEndingWith(dir, suffix).some((path) => readFileSync(path, 'utf8').includes(needle));
}

test.describe('Update Definition, Export and Documentation', () => {
  let launched: LaunchedApp | undefined;
  let v1: TestSoapServer | undefined;
  let v2: TestSoapServer | undefined;
  let projectDir = '';
  let docsPath = '';

  test.beforeEach(async () => {
    v1 = await startTestSoapServer({ fixture: 'versioned/v1' });
    v2 = await startTestSoapServer({ fixture: 'versioned/v2' });
    projectDir = join(mkdtempSync(join(tmpdir(), 'wirebench-e2e-projects-')), 'Versioned');
    docsPath = join(mkdtempSync(join(tmpdir(), 'wirebench-e2e-docs-')), 'definition.html');
  });

  test.afterEach(async () => {
    if (launched) {
      await launched.close();
      launched = undefined;
    }
    await v1?.close();
    await v2?.close();
    v1 = undefined;
    v2 = undefined;
    for (const dir of [projectDir, docsPath]) {
      if (dir.length > 0) {
        rmSync(join(dir, '..'), { recursive: true, force: true });
      }
    }
    projectDir = '';
    docsPath = '';
  });

  test('updates v1 to v2: new request, kept edit, orphaned row and a backup', async () => {
    launched = await launchApp({
      folderDialogPath: projectDir,
      extraEnv: { WIREBENCH_E2E_DIALOG_SAVE: docsPath },
    });
    const page = launched.window;
    await createProjectWithCalculator(page, v1!);
    await expect(page.locator('[data-testid="explorer-tree-row"]', { hasText: 'VersionedService' })).toHaveCount(1, {
      timeout: 20_000,
    });

    // Edit Echo's request (the second `Request 1`: Add, Echo, Legacy in alphabetical order).
    await openRequest(page, 1);
    await setMonacoText(page, 'Request envelope XML', EDITED_ECHO);
    await expect.poll(async () => await envelopeText(page), { timeout: 15_000 }).toContain('WB-EDIT');
    // The backup is a copy of what is on disk, so the edit has to be saved before the update
    // runs — otherwise the `.bak` would preserve the envelope as imported, not as edited.
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+s' : 'Control+s');
    await expect.poll(() => anyFileContains(projectDir, '.xml', 'WB-EDIT'), { timeout: 20_000 }).toBe(true);

    await interfaceMenu(page, 'Update Definition…');
    const dialog = page.getByTestId('update-definition-dialog');
    await expect(dialog).toBeVisible({ timeout: 20_000 });
    await page.getByTestId('update-definition-url').fill(v2!.wsdlUrl);
    await page.getByTestId('update-definition-plan').click();

    await expect(page.getByTestId('update-plan-new')).toContainText('Subtract', { timeout: 20_000 });
    await expect(page.getByTestId('update-plan-removed')).toContainText('Legacy');
    await expect(page.getByTestId('update-plan-changed')).toContainText('Echo');

    await page.getByTestId('update-definition-submit').click();
    await expect(dialog).toBeHidden({ timeout: 20_000 });

    // The new operation brought a request with it, so there are now four `Request 1` rows.
    await expect(page.locator('[data-testid="explorer-tree-row"]', { hasText: 'Request 1' })).toHaveCount(4, {
      timeout: 20_000,
    });
    await expect(page.locator('[data-testid="explorer-tree-row"]', { hasText: 'Subtract' })).toHaveCount(1);
    // The removed operation's request is still there, badged rather than deleted.
    await expect(page.getByTestId('explorer-orphaned-badge')).toHaveCount(1);

    // The edit survived the recreate, and the newly required element arrived alongside it.
    await openRequest(page, 1);
    await expect.poll(async () => await envelopeText(page), { timeout: 20_000 }).toContain('WB-EDIT');
    await expect.poll(async () => await envelopeText(page), { timeout: 20_000 }).toContain('lang');

    await expect.poll(() => filesEndingWith(projectDir, '.xml.bak').length, { timeout: 20_000 }).toBe(1);
    expect(readFileSync(filesEndingWith(projectDir, '.xml.bak')[0] ?? '', 'utf8')).toContain('WB-EDIT');
  });

  test('generates HTML documentation and exports the definition folder', async () => {
    launched = await launchApp({
      folderDialogPath: projectDir,
      extraEnv: { WIREBENCH_E2E_DIALOG_SAVE: docsPath },
    });
    const page = launched.window;
    await createProjectWithCalculator(page, v1!);

    await interfaceMenu(page, 'Generate Documentation…');
    await expect(page.getByTestId('generate-docs-dialog')).toBeVisible({ timeout: 20_000 });
    await page.getByTestId('generate-docs-submit').click();
    await expect(page.getByTestId('generate-docs-dialog')).toBeHidden({ timeout: 20_000 });

    await expect.poll(() => existsSync(docsPath), { timeout: 20_000 }).toBe(true);
    const html = readFileSync(docsPath, 'utf8');
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html).toContain('VersionedService');

    // The folder picker is pinned to the project folder, which is where the export lands.
    await interfaceMenu(page, 'Export Definition…');
    await expect
      .poll(() => readdirSync(projectDir).filter((name) => name.endsWith('.wsdl')).length, { timeout: 20_000 })
      .toBeGreaterThan(0);
    const exported = readdirSync(projectDir).find((name) => name.endsWith('.wsdl')) ?? '';
    expect(readFileSync(join(projectDir, exported), 'utf8')).toContain('VersionedService');
  });
});
