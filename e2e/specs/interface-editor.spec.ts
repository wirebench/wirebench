import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { launchApp, type LaunchedApp } from '../helpers/launch-app.js';
import { monacoEditor } from '../helpers/editor.js';
import { createProjectWithCalculator, openFirstRequest } from '../helpers/project.js';
import { startTestSoapServer, type TestSoapServer } from '../helpers/test-server.js';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

/** The platform's go-to-definition modifier, matching the Monaco Mod+click binding. */
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

/**
 * How many bound operations a WSDL declares — one summary per `wsdl:binding` operation, which
 * is exactly what the Overview counts. Read from the fixture so the assertion cannot drift if
 * the fixture changes.
 */
function boundOperationCount(wsdlPath: string): number {
  const text = readFileSync(wsdlPath, 'utf-8');
  // Only a `wsdl:binding` carries `type=`; the nested `soap:binding` is self-closing and must
  // not start a block of its own.
  const bindings = text.match(/<(?:\w+:)?binding\b[^>]*\btype="[\s\S]*?<\/(?:\w+:)?binding>/g) ?? [];
  return bindings.reduce(
    (total, binding) => total + (binding.match(/<(?:\w+:)?operation\b[^>]*\bname="/g) ?? []).length,
    0,
  );
}

/** Opens the Interface editor from the explorer's interface row context menu. */
async function showInterfaceViewer(page: Page, rowText: string): Promise<void> {
  const row = page.locator('[data-testid="explorer-tree-row"]', { hasText: rowText }).first();
  await expect(row).toBeVisible({ timeout: 20_000 });
  await row.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Show Interface Viewer' }).click();
  await expect(page.getByTestId('interface-editor')).toBeVisible({ timeout: 20_000 });
}

test.describe('Interface editor', () => {
  let launched: LaunchedApp | undefined;
  let server: TestSoapServer | undefined;
  let projectDir = '';

  test.beforeEach(async () => {
    server = await startTestSoapServer({ fixture: 'calculator' });
    projectDir = join(mkdtempSync(join(tmpdir(), 'wirebench-e2e-projects-')), 'InterfaceViewer');
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
    if (projectDir.length > 0) {
      rmSync(projectDir, { recursive: true, force: true });
      projectDir = '';
    }
  });

  test('shows the overview, documents and schema, and lands on a declaration from the editor', async () => {
    launched = await launchApp({ folderDialogPath: projectDir });
    const page = launched.window;
    await createProjectWithCalculator(page, server!);

    await showInterfaceViewer(page, 'Calculator');

    // Overview: the operation count is the fixture's own, and the served WSDL is one document.
    const expectedOperations = boundOperationCount(join(repoRoot, 'fixtures/wsdl/public/calculator/service.wsdl'));
    await expect(page.getByTestId('interface-operation-count')).toHaveText(String(expectedOperations));
    await expect(page.getByTestId('interface-document-count')).toHaveText('1');

    // WSDL Content: one document, shown read-only.
    await page.getByRole('tab', { name: 'WSDL Content' }).click();
    await expect(page.getByTestId('wsdl-document-item')).toHaveCount(1);
    await expect(monacoEditor(page, 'Definition document XML')).toBeVisible({ timeout: 20_000 });

    // Schema: the tempuri namespace lists the Add element.
    await page.getByRole('tab', { name: 'Schema' }).click();
    await expect(page.locator('[data-testid="schema-namespace"][data-uri="http://tempuri.org/"]')).toBeVisible();
    await page.locator('[data-testid="schema-component"][data-name="Add"]').first().click();
    await expect(page.getByTestId('schema-detail-name')).toHaveText('Add');

    // Go to definition: Mod+click on the intA line of the request envelope selects its
    // declaration in this very viewer.
    await openFirstRequest(page);
    const intALine = monacoEditor(page, 'Request envelope XML')
      .locator('.view-line')
      .filter({ hasText: 'intA' })
      .first();
    await expect(intALine).toBeVisible({ timeout: 20_000 });
    await intALine.click({ modifiers: [MOD] });

    await expect(page.getByTestId('interface-editor')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('schema-detail-name')).toHaveText('intA');
    await expect(page.getByTestId('schema-detail-snippet')).toContainText('name="intA"');

    // "Go to source" hands the declaration's document and line to the WSDL Content tab.
    await page.getByTestId('schema-goto-source').click();
    await expect(page.getByTestId('wsdl-document-location')).toContainText('service');
  });

  test('lists every document of a nested import graph', async () => {
    launched = await launchApp({ folderDialogPath: projectDir });
    const page = launched.window;

    await page.getByTestId('welcome-new-project').click();
    await expect(page.getByTestId('new-project-name')).toBeVisible();
    await page.getByTestId('new-project-create').click();

    // The crafted fixture's imports are relative, which the in-process test server cannot
    // serve — so this one is imported from the working tree instead.
    await page.getByTestId('welcome-import').click();
    await page.getByRole('tab', { name: 'File' }).click();
    await page.getByLabel('File path').fill(join(repoRoot, 'fixtures/wsdl/crafted/nested-imports/service.wsdl'));
    await page.getByTestId('import-submit').click();

    await showInterfaceViewer(page, 'EchoService');
    await page.getByRole('tab', { name: 'WSDL Content' }).click();
    await expect(page.getByTestId('wsdl-document-item')).toHaveCount(4, { timeout: 20_000 });
  });
});
