import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { launchApp, type LaunchedApp } from '../helpers/launch-app.js';
import {
  createProjectWithCalculator,
  expectReopenedWorkspace,
  openFirstRequest,
  workspaceProjectDir,
} from '../helpers/project.js';
import { setMonacoText } from '../helpers/editor.js';
import { startTestSoapServer, type TestSoapServer } from '../helpers/test-server.js';

/** A 64-byte PNG-ish blob: a real signature so the type sniffing table recognises it, then filler. */
const FIXTURE_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(56, 0x2a),
]);

/** The Content-ID the envelope refers to, set on the attachment through the grid's inline editor. */
const CONTENT_ID = 'pixel@wirebench';

/**
 * The plan's attachments acceptance: a file added to a request goes into the project cache,
 * rides an MTOM send to the echo route, comes back as a response part, and saves back to disk
 * byte for byte — then survives a relaunch, because it is project data, not editor state.
 */
test.describe('attachments', () => {
  let launched: LaunchedApp | undefined;
  let server: TestSoapServer | undefined;
  let userDataDir: string | undefined;
  let filesDir: string | undefined;

  test.afterEach(async () => {
    if (launched) {
      await launched.close();
      launched = undefined;
    }
    if (server) {
      await server.close();
      server = undefined;
    }
    for (const dir of [userDataDir, filesDir]) {
      if (dir !== undefined) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
    userDataDir = undefined;
    filesDir = undefined;
  });

  test('adds a file, sends it as an MTOM part, saves the echoed part back, and reloads it', async () => {
    server = await startTestSoapServer({ fixture: 'calculator', respondToCalculatorAdd: true });
    userDataDir = mkdtempSync(join(tmpdir(), 'wirebench-e2e-profile-'));
    filesDir = mkdtempSync(join(tmpdir(), 'wirebench-e2e-files-'));
    const sourcePath = join(filesDir, 'pixel.png');
    const savedPath = join(filesDir, 'saved-from-response.png');
    writeFileSync(sourcePath, FIXTURE_BYTES);

    launched = await launchApp({
      userDataDir,
      keepUserDataDir: true,
      // Playwright cannot drive the native Add-attachments / Save-as dialogs, so both are pinned.
      extraEnv: { WIREBENCH_E2E_OPEN_PATH: sourcePath, WIREBENCH_E2E_SAVE_PATH: savedPath },
    });
    const page = launched.window;
    await createProjectWithCalculator(page, server, { expectProjectName: 'Attachments Project' });
    await openFirstRequest(page);

    // The /mime route echoes every part it receives, so what comes back proves what went out.
    await page.getByTestId('request-endpoint').fill(`${server.url}/mime`);

    // --- reference an attachment from the envelope, before the strip takes the pane's room --
    // Monaco does not re-measure once the inspector panel has squeezed it to nothing, so the
    // envelope is written first and the attachment is then given the Content-ID it names.
    await setMonacoText(
      page,
      'Request envelope XML',
      `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tem="http://tempuri.org/">
  <soapenv:Body>
    <tem:Add>
      <tem:intA>cid:${CONTENT_ID}</tem:intA>
      <tem:intB>2</tem:intB>
    </tem:Add>
  </soapenv:Body>
</soapenv:Envelope>`,
    );

    // --- add the file through the (pinned) picker, copying it into the project -------------
    await page.getByRole('tablist', { name: 'Request inspectors' }).getByRole('tab', { name: 'Attachments' }).click();
    await expect(page.getByTestId('attachments-copy')).toBeChecked();
    await page.getByTestId('attachments-add').click();

    const rows = page.locator('[data-testid="attachment-row"]');
    await expect(rows).toHaveCount(1, { timeout: 10_000 });
    await expect(rows.first()).toContainText('pixel.png');
    await expect(rows.first()).toContainText('64 B');

    // The blob landed in the project's own cache, named by its digest.
    const digest = createHash('sha256').update(FIXTURE_BYTES).digest('hex');
    expect(existsSync(join(workspaceProjectDir(userDataDir), 'attachments', digest))).toBe(true);

    // Give it the Content-ID the envelope refers to, through the grid's inline editor.
    const contentIdCell = page.getByLabel('Content ID of pixel.png');
    await contentIdCell.fill(CONTENT_ID);
    await contentIdCell.press('Enter');
    await expect(contentIdCell).toHaveValue(CONTENT_ID);

    // The inspector's own "MTOM is off" hint is the way into the request properties.
    await page.getByRole('button', { name: 'Request properties' }).click();
    await page.getByLabel('Enable MTOM').check();
    await expect(page.getByLabel('Enable MTOM')).toBeChecked();

    // --- send, and find the echoed part in the response inspector ---------------------------
    await page.getByTestId('request-send').click();
    await expect(page.getByTestId('response-status')).toContainText('200', { timeout: 20_000 });

    const responseInspectors = page.getByRole('tablist', { name: 'Response inspectors' });
    await responseInspectors.getByRole('tab', { name: /^Attachments/ }).click();
    const responseRows = page.locator('[data-testid="response-attachment-row"]');
    await expect(responseRows).toHaveCount(1, { timeout: 10_000 });
    await expect(responseRows.first()).toContainText('64 B');

    // --- save it back; the bytes must be the ones that went out -----------------------------
    await page.getByLabel('Save attachment as…').click();
    await expect.poll(() => existsSync(savedPath), { timeout: 10_000 }).toBe(true);
    expect(readFileSync(savedPath)).toEqual(FIXTURE_BYTES);

    // --- relaunch: the attachment is project data, so it comes back --------------------------
    await launched.close();
    launched = await launchApp({
      userDataDir,
      keepUserDataDir: true,
      extraEnv: { WIREBENCH_E2E_OPEN_PATH: sourcePath, WIREBENCH_E2E_SAVE_PATH: savedPath },
    });
    const reopened = launched.window;
    await expectReopenedWorkspace(reopened);

    await openFirstRequest(reopened);
    await reopened
      .getByRole('tablist', { name: 'Request inspectors' })
      .getByRole('tab', { name: 'Attachments' })
      .click();
    const reloadedRows = reopened.locator('[data-testid="attachment-row"]');
    await expect(reloadedRows).toHaveCount(1, { timeout: 10_000 });
    await expect(reloadedRows.first()).toContainText('pixel.png');
  });
});
