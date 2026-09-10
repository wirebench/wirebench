import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { launchApp, type LaunchedApp } from '../helpers/launch-app.js';
import { setMonacoText } from '../helpers/editor.js';
import { createProjectWithCalculator, openFirstRequest } from '../helpers/project.js';
import { startTestSoapServer, type TestSoapServer } from '../helpers/test-server.js';

const EDITED_ENVELOPE = [
  '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tem="http://tempuri.org/">',
  '   <soapenv:Header/>',
  '   <soapenv:Body>',
  '      <tem:Add>',
  '         <tem:intA>5</tem:intA>',
  '         <tem:intB>?</tem:intB>',
  '      </tem:Add>',
  '   </soapenv:Body>',
  '</soapenv:Envelope>',
].join('\n');

/**
 * Recreate moved from a toolbar split button to the request pane's own context menu (Task 32b),
 * so every spec that recreates a request goes through the same two clicks.
 */
async function recreateFromContextMenu(page: Page): Promise<void> {
  await page.getByTestId('request-pane-surface').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Recreate request (keep values)' }).click();
}

test.describe('request editor actions', () => {
  let launched: LaunchedApp | undefined;
  let server: TestSoapServer | undefined;
  // Assigned in `beforeEach`; kept non-optional so `launchApp` (under
  // `exactOptionalPropertyTypes`) does not have to be handed `string | undefined`.
  let userDataDir = '';
  let projectDir = '';

  test.beforeEach(async () => {
    server = await startTestSoapServer({ fixture: 'calculator', respondToCalculatorAdd: true });
    userDataDir = mkdtempSync(join(tmpdir(), 'wirebench-e2e-profile-'));
    projectDir = join(mkdtempSync(join(tmpdir(), 'wirebench-e2e-projects-')), 'EditorActions');
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
    for (const dir of [userDataDir, projectDir]) {
      if (dir.length > 0) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
    userDataDir = '';
    projectDir = '';
  });

  test('the layout orientation toggle survives a relaunch', async () => {
    launched = await launchApp({ userDataDir, folderDialogPath: projectDir, keepUserDataDir: true });
    await createProjectWithCalculator(launched.window, server!);
    await openFirstRequest(launched.window);

    await launched.window.getByTestId('layout-orientation').click();
    await expect(launched.window.getByRole('button', { name: 'Place panes side by side' })).toBeVisible();

    await launched.close();
    launched = await launchApp({ userDataDir, folderDialogPath: projectDir, keepUserDataDir: true });
    const page = launched.window;
    // The relaunched app reopens the folder from Recent, then the request from the explorer.
    await page.getByTestId('recent-project').first().click();
    await openFirstRequest(page);

    // Stacked is what the persisted default said; the button offers the way back to side-by-side.
    await expect(page.getByRole('button', { name: 'Place panes side by side' })).toBeVisible({ timeout: 20_000 });
  });

  test('Recreate (keep values) keeps an edited intA', async () => {
    launched = await launchApp({ userDataDir, folderDialogPath: projectDir, keepUserDataDir: true });
    const page = launched.window;
    await createProjectWithCalculator(page, server!);
    await openFirstRequest(page);

    await setMonacoText(page, 'Request envelope XML', EDITED_ENVELOPE);
    await recreateFromContextMenu(page);

    await expect
      .poll(
        async () => {
          const lines = await page
            .locator('[aria-label="Request envelope XML"]')
            .locator('xpath=ancestor::*[contains(@class, "monaco-editor")][1]')
            .locator('.view-line')
            .allTextContents();
          // Monaco wraps long lines and pads with non-breaking spaces, so compare with every
          // whitespace character removed rather than line by line.
          return lines.join('').replace(/\s|\u00a0/g, '');
        },
        { timeout: 15_000 },
      )
      .toContain('<tem:intA>5</tem:intA>');
  });

  test('the endpoint field shows the whole URL the request will be sent to', async () => {
    launched = await launchApp({ userDataDir, folderDialogPath: projectDir, keepUserDataDir: true });
    const page = launched.window;
    await createProjectWithCalculator(page, server!);
    await openFirstRequest(page);

    // The WSDL's declared port address, which is where the imported project points.
    await expect(page.getByTestId('request-endpoint')).toHaveValue(`${server!.url}/soap`, { timeout: 20_000 });
  });

  test('the Code panel previews the cURL command and copies it', async () => {
    launched = await launchApp({ userDataDir, folderDialogPath: projectDir, keepUserDataDir: true });
    const page = launched.window;
    await createProjectWithCalculator(page, server!);
    await openFirstRequest(page);

    await page.getByTestId('request-code').click();
    const preview = page.getByTestId('code-panel-preview');
    await expect(preview).toContainText('curl --request POST', { timeout: 20_000 });
    await expect(preview).toContainText(`${server!.url}/soap`);

    await page.getByTestId('code-panel-copy').click();

    await expect
      .poll(async () => launched!.app.evaluate(({ clipboard }) => clipboard.readText()), { timeout: 10_000 })
      .toContain('curl');
    const command = await launched.app.evaluate(({ clipboard }) => clipboard.readText());
    expect(command).toContain('tem:Add');
  });

  test('Import cURL creates a request pointing at the pasted endpoint', async () => {
    launched = await launchApp({ userDataDir, folderDialogPath: projectDir, keepUserDataDir: true });
    const page = launched.window;
    await createProjectWithCalculator(page, server!);
    await openFirstRequest(page);

    const command = [
      `curl --request POST '${server!.url}' \\`,
      "  --header 'Content-Type: text/xml; charset=utf-8' \\",
      '  --header \'SOAPAction: "http://tempuri.org/Add"\' \\',
      "  --data-binary @- <<'EOF'",
      '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tem="http://tempuri.org/">' +
        '<soapenv:Body><tem:Add><tem:intA>3</tem:intA><tem:intB>4</tem:intB></tem:Add></soapenv:Body>' +
        '</soapenv:Envelope>',
      'EOF',
    ].join('\n');

    await page.getByTestId('request-code').click();
    await page.getByTestId('code-panel-import').click();
    await page.getByLabel('cURL command').fill(command);
    await expect(page.getByText(server!.url, { exact: false }).first()).toBeVisible();
    await page.getByTestId('import-curl-submit').click();

    // The imported request shows up in the explorer, and its editor resolves to the pasted URL.
    await expect(page.locator('[data-testid="explorer-tree-row"]', { hasText: 'Request 2' }).first()).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByTestId('request-endpoint')).toHaveValue(server!.url, { timeout: 20_000 });
  });
});
