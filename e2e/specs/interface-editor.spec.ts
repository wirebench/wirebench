import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { launchApp, removeDirSync, type LaunchedApp } from '../helpers/launch-app.js';
import { monacoEditor } from '../helpers/editor.js';
import { createProjectWithCalculator, openFirstRequest } from '../helpers/project.js';
import { startTestSoapServer, type TestSoapServer } from '../helpers/test-server.js';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

/** The platform's go-to-definition modifier, matching the Monaco Mod+click binding. */
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

/**
 * How many operation rows the explorer shows for the imported interfaces — the same operations
 * the Overview counts, read from the app itself rather than by re-parsing the WSDL.
 */
async function explorerOperationCount(page: Page): Promise<number> {
  const rows = page.locator('[data-testid="explorer-tree-row"][data-tree-id^="op:"]');
  await expect.poll(async () => await rows.count(), { timeout: 20_000 }).toBeGreaterThan(0);

  // react-arborist virtualises the tree: only the rows inside the scroll viewport exist in the
  // DOM, so counting what is mounted right now measures the window rather than the interface —
  // a CI display that clamps the shell shorter than a developer's simply holds fewer rows.
  // Page the list a viewport at a time instead, collecting ids as they mount, until the
  // container stops scrolling.
  const list = page.getByTestId('explorer-tree-scroll');
  const seen = new Set<string>();
  const collect = async (): Promise<void> => {
    for (const row of await rows.all()) {
      const id = await row.getAttribute('data-tree-id');
      if (id !== null) seen.add(id);
    }
  };
  let previousTop = -1;
  for (;;) {
    await collect();
    const top = await list.evaluate((element: { scrollTop: number; clientHeight: number }) => {
      element.scrollTop += element.clientHeight;
      return element.scrollTop;
    });
    if (top === previousTop) break;
    previousTop = top;
    // react-window mounts the newly revealed rows on the render that follows the scroll event.
    await page.waitForTimeout(100);
  }
  await collect();
  // Put the list back at the top before returning. Anything left scrolled has the tree's first
  // rows — the interface row every caller goes on to right-click — unmounted, and a `hasText`
  // lookup then lands on whatever *is* mounted (a `CalculatorSoap` binding row reads as
  // "Calculator" too), whose context menu has no "Show Interface Viewer" in it.
  await list.evaluate((element: { scrollTop: number }) => {
    element.scrollTop = 0;
  });
  return seen.size;
}

/** Opens the Interface editor from the explorer's interface row context menu. */
async function showInterfaceViewer(page: Page, rowText: string): Promise<void> {
  // Scoped to an `iface:` row: a binding row is named after the binding, which carries the
  // interface's name as a prefix (`CalculatorSoap`), so plain `hasText` can match one of those.
  const row = page.locator('[data-testid="explorer-tree-row"][data-tree-id^="iface:"]', { hasText: rowText }).first();
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
      removeDirSync(projectDir);
      projectDir = '';
    }
  });

  test('shows the overview, documents and schema, and lands on a declaration from the editor', async () => {
    launched = await launchApp({ folderDialogPath: projectDir });
    const page = launched.window;
    await createProjectWithCalculator(page, server!);

    const expectedOperations = await explorerOperationCount(page);
    await showInterfaceViewer(page, 'Calculator');

    // Overview: the operation count matches the explorer's own rows for this interface, and the
    // served WSDL is one document.
    await expect(page.getByTestId('interface-operation-count')).toHaveText(String(expectedOperations));
    await expect(page.getByTestId('interface-document-count')).toHaveText('1');

    // WSDL Content: one document, shown read-only.
    await page.getByRole('tab', { name: 'WSDL Content' }).click();
    await expect(page.getByTestId('wsdl-document-item')).toHaveCount(1);
    await expect(monacoEditor(page, 'Definition document XML')).toBeVisible({ timeout: 20_000 });

    // Schema: the tempuri namespace lists the Add element. The row is scoped to that namespace
    // and to the element group — another namespace may well declare an `Add` of its own.
    await page.getByRole('tab', { name: 'Schema' }).click();
    await expect(page.locator('[data-testid="schema-namespace"][data-uri="http://tempuri.org/"]')).toBeVisible();
    await page
      .locator(
        '[data-testid="schema-component"][data-namespace="http://tempuri.org/"][data-kind="element"][data-name="Add"]',
      )
      .click();
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

    // "Go to source" hands the declaration's document and line to the WSDL Content tab, which
    // reveals it on landing — the declaration's own line is on screen without any scrolling.
    await page.getByTestId('schema-goto-source').click();
    await expect(page.getByTestId('wsdl-document-location')).toContainText('service');
    await expect(
      monacoEditor(page, 'Definition document XML').locator('.view-line').filter({ hasText: 'name="intA"' }).first(),
    ).toBeVisible({ timeout: 20_000 });
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
