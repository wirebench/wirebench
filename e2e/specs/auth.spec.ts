import { mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { launchApp, removeDirSync, type LaunchedApp } from '../helpers/launch-app.js';
import { createProjectWithCalculator, openFirstRequest, saveAll, workspaceProjectDir } from '../helpers/project.js';
import { startTestSoapServer, type TestSoapServer } from '../helpers/test-server.js';

const PASSWORD = 'pass';

/** Every file path under `dir`, recursively (files only). */
function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    out.push(...(statSync(full).isDirectory() ? listFiles(full) : [full]));
  }
  return out;
}

/**
 * The plan's Basic-auth acceptance, end to end: credentials typed into the Auth inspector are
 * stored as a `secretRef`, a non-preemptive send is challenged and retried, a wrong password
 * surfaces the final 401, and a preemptive send needs no challenge at all.
 */
test.describe('auth', () => {
  let launched: LaunchedApp | undefined;
  let server: TestSoapServer | undefined;
  let userDataDir: string | undefined;

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
      if (dir !== undefined) removeDirSync(dir);
    }
    userDataDir = undefined;
  });

  test('Basic auth passes a 401 challenge, fails with a wrong password, and skips the challenge when preemptive', async () => {
    server = await startTestSoapServer({ fixture: 'calculator', respondToCalculatorAdd: true });
    userDataDir = mkdtempSync(join(tmpdir(), 'wirebench-e2e-profile-'));

    launched = await launchApp({ userDataDir, keepUserDataDir: true });
    const page = launched.window;
    await createProjectWithCalculator(page, server, { expectProjectName: 'Auth Project' });
    const projectDir = workspaceProjectDir(userDataDir);
    await openFirstRequest(page);

    // The /auth/basic route demands `user:pass` and challenges anything else with a 401.
    await page.getByTestId('request-endpoint').fill(`${server.url}/auth/basic`);

    await page.getByRole('tablist', { name: 'Request inspectors' }).getByRole('tab', { name: 'Auth' }).click();
    // The WSS section of the Details panel has a "Password" label of its own, so every auth
    // field is looked up inside the request inspector panel rather than page-wide.
    const panel = page.getByTestId('inspector-panel-request');
    const inherit = page.getByTestId('auth-inherit');
    await expect(inherit).toBeChecked();
    await inherit.uncheck();

    await panel.getByLabel('Authentication type').selectOption('basic');
    await panel.getByLabel('Username').fill('user');
    await panel.getByRole('button', { name: 'Set…' }).click();
    await panel.getByPlaceholder('Enter password').fill(PASSWORD);
    await panel.getByRole('button', { name: 'Save' }).click();
    await expect(panel.getByLabel('Password')).toHaveText('••••••••');

    // --- challenge flow: no preemptive header, so the first attempt is answered with a 401 ---
    const preemptive = panel.getByLabel('Request preemptive');
    await expect(preemptive).toBeChecked();
    await preemptive.uncheck();

    await page.getByTestId('request-send').click();
    await expect(page.getByTestId('response-status')).toContainText('200', { timeout: 20_000 });
    await expect(page.getByTestId('response-status')).toContainText('Authenticated after 401 challenge');

    // Saving is manual by default, so say when the project should be on disk before reading it.
    await saveAll(page);

    // --- the password never reaches disk in plaintext; only its ref is saved -----------------
    const passwordRefPattern = /passwordRef:\s*['"]?([\w.-]+)['"]?/;
    await expect
      .poll(
        () => {
          const match = listFiles(projectDir)
            .map((file) => readFileSync(file, 'utf8').match(passwordRefPattern))
            .find((found) => found !== null);
          return match?.[1];
        },
        { timeout: 15_000 },
      )
      .not.toBeUndefined();
    const passwordRefFile = listFiles(projectDir).find((file) => passwordRefPattern.test(readFileSync(file, 'utf8')))!;
    const passwordRefValue = readFileSync(passwordRefFile, 'utf8').match(passwordRefPattern)![1]!;
    // A ref is a store lookup key, not the secret itself — it must not just be `pass` verbatim.
    expect(passwordRefValue).not.toBe(PASSWORD);

    const basicHeaderValue = Buffer.from(`user:${PASSWORD}`, 'utf-8').toString('base64');
    const plaintextLeakChecks = (dir: string): void => {
      for (const file of listFiles(dir)) {
        const text = readFileSync(file, 'utf8');
        // The literal ref this send is keyed on must actually be present in the project file
        // (not just *some* passwordRef somewhere) — proving the save round-tripped this value.
        if (file === passwordRefFile) {
          expect(text, `${file} must contain the passwordRef it was saved under`).toContain(passwordRefValue);
        }
        expect(text, `${file} must not contain the plaintext password as a scalar`).not.toMatch(
          /(^|[^a-zA-Z])pass([^a-zA-Z]|$)/,
        );
        expect(text, `${file} must not contain the preemptive Basic auth header`).not.toContain(basicHeaderValue);
      }
    };
    plaintextLeakChecks(projectDir);

    // --- a wrong password surfaces the final 401 as a normal response ------------------------
    await panel.getByRole('button', { name: 'Replace…' }).click();
    await panel.getByPlaceholder('Enter password').fill('wrong');
    await panel.getByRole('button', { name: 'Save' }).click();
    await expect(panel.getByLabel('Password')).toHaveText('••••••••');

    await page.getByTestId('request-send').click();
    await expect(page.getByTestId('response-status')).toContainText('401', { timeout: 20_000 });

    // --- back to the right password, sent preemptively: 200 with no challenge ----------------
    await panel.getByRole('button', { name: 'Replace…' }).click();
    await panel.getByPlaceholder('Enter password').fill(PASSWORD);
    await panel.getByRole('button', { name: 'Save' }).click();
    await expect(panel.getByLabel('Password')).toHaveText('••••••••');
    await preemptive.check();
    await expect(preemptive).toBeChecked();

    await page.getByTestId('request-send').click();
    await expect(page.getByTestId('response-status')).toContainText('200', { timeout: 20_000 });
    await expect(page.getByTestId('response-status')).not.toContainText('Authenticated after 401 challenge');

    // The profile is scanned only once the app has let go of it: Chromium keeps its own files
    // (the profile lock, the leveldb logs) open with a share mode Windows refuses a reader,
    // which made `readFileSync` throw EBUSY there. Closing first also makes this the *final*
    // state of the profile — after all three passwords were saved — which is strictly more
    // than the mid-test read covered.
    await launched.close();
    launched = undefined;
    plaintextLeakChecks(userDataDir);
  });

  test('NTLM authenticates through the three-leg handshake and fails with a wrong password', async () => {
    server = await startTestSoapServer({ fixture: 'calculator', respondToCalculatorAdd: true });
    userDataDir = mkdtempSync(join(tmpdir(), 'wirebench-e2e-profile-'));

    launched = await launchApp({ userDataDir, keepUserDataDir: true });
    const page = launched.window;
    await createProjectWithCalculator(page, server, { expectProjectName: 'NTLM Project' });
    await openFirstRequest(page);

    // `/auth/ntlm` runs the real NTLMv2 handshake against user/pass in WORKGROUP.
    await page.getByTestId('request-endpoint').fill(`${server.url}/auth/ntlm`);

    await page.getByRole('tablist', { name: 'Request inspectors' }).getByRole('tab', { name: 'Auth' }).click();
    const panel = page.getByTestId('inspector-panel-request');
    await page.getByTestId('auth-inherit').uncheck();

    await panel.getByLabel('Authentication type').selectOption('ntlm');
    await panel.getByLabel('Username').fill('user');
    await panel.getByLabel('Domain').fill('WORKGROUP');
    await panel.getByLabel('Workstation').fill('WIRETEST');
    await panel.getByRole('button', { name: 'Set…' }).click();
    await panel.getByPlaceholder('Enter password').fill(PASSWORD);
    await panel.getByRole('button', { name: 'Save' }).click();
    await expect(panel.getByLabel('Password')).toHaveText('••••••••');

    await page.getByTestId('request-send').click();
    await expect(page.getByTestId('response-status')).toContainText('200', { timeout: 20_000 });

    // --- a wrong password surfaces the handshake's final 401 ---------------------------------
    await panel.getByRole('button', { name: 'Replace…' }).click();
    await panel.getByPlaceholder('Enter password').fill('wrong');
    await panel.getByRole('button', { name: 'Save' }).click();
    await expect(panel.getByLabel('Password')).toHaveText('••••••••');

    await page.getByTestId('request-send').click();
    await expect(page.getByTestId('response-status')).toContainText('401', { timeout: 20_000 });
  });
});
