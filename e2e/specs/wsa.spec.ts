/**
 * WS-Addressing end to end: import a WSDL that declares `wsaw:UsingAddressing`, confirm the
 * import turned addressing on by itself, and send to the echoing `/soap` route — which hands
 * the addressed envelope straight back, proving the `wsa:*` headers were on the wire and not
 * merely configured.
 *
 * The second send is the point of the MessageID claim: a fresh `urn:uuid` per send is what
 * makes a request correlatable, and a header block baked in once would break that silently.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { launchApp, type LaunchedApp } from '../helpers/launch-app.js';
import { createProjectWithFixture, openFirstRequest } from '../helpers/project.js';
import { startTestSoapServer, type TestSoapServer } from '../helpers/test-server.js';

/** The `urn:uuid:` MessageID of the envelope the echo route handed back. */
function messageIdOf(text: string): string | undefined {
  return /urn:uuid:[0-9a-fA-F-]{36}/.exec(text)?.[0];
}

test.describe('wsa', () => {
  let launched: LaunchedApp | undefined;
  let server: TestSoapServer | undefined;
  let userDataDir: string | undefined;
  let projectDir: string | undefined;

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
      if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    }
    userDataDir = undefined;
    projectDir = undefined;
  });

  test('auto-enables addressing from the WSDL and sends a fresh MessageID per send', async () => {
    server = await startTestSoapServer({ fixture: 'ws-addressing' });
    userDataDir = mkdtempSync(join(tmpdir(), 'wirebench-e2e-profile-'));
    projectDir = join(mkdtempSync(join(tmpdir(), 'wirebench-e2e-projects-')), 'WSA Project');
    launched = await launchApp({ userDataDir, folderDialogPath: projectDir, keepUserDataDir: true });
    const page = launched.window;
    await createProjectWithFixture(page, server, 'ws-addressing', { expectProjectName: 'WSA Project' });
    await openFirstRequest(page);

    // --- the inspector shows addressing on, with the operation's action ----------------------
    await page.getByRole('tablist', { name: 'Request inspectors' }).getByRole('tab', { name: 'WS-A' }).click();
    await expect(page.getByTestId('wsa-inherit')).toBeChecked();
    await expect(page.getByTestId('wsa-enabled')).toBeChecked();
    await expect(page.getByTestId('wsa-effective')).toContainText('urn:wb:wsa:Echo', { timeout: 15_000 });

    // --- send: the echo hands back exactly what went out -------------------------------------
    await page.getByTestId('request-endpoint').fill(`${server.url}/soap`);
    await page.getByTestId('request-send').click();
    await expect(page.getByTestId('response-status')).toContainText('200', { timeout: 30_000 });

    const responseEditor = page.getByTestId('response-editor');
    await expect(responseEditor).toContainText('wsa:Action', { timeout: 15_000 });
    await expect(responseEditor).toContainText('wsa:To');
    await expect(responseEditor).toContainText('urn:uuid:');

    const first = messageIdOf((await responseEditor.textContent()) ?? '');
    expect(first).toBeDefined();

    // --- a second send must not reuse the first send's MessageID -----------------------------
    await page.getByTestId('request-send').click();
    await expect
      .poll(async () => messageIdOf((await responseEditor.textContent()) ?? ''), { timeout: 30_000 })
      .not.toBe(first);
  });
});
