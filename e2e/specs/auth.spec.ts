import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { launchApp, type LaunchedApp } from '../helpers/launch-app.js';
import { createProjectWithCalculator, openFirstRequest } from '../helpers/project.js';
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

  test('Basic auth passes a 401 challenge, fails with a wrong password, and skips the challenge when preemptive', async () => {
    server = await startTestSoapServer({ fixture: 'calculator', respondToCalculatorAdd: true });
    userDataDir = mkdtempSync(join(tmpdir(), 'wirebench-e2e-profile-'));
    projectDir = join(mkdtempSync(join(tmpdir(), 'wirebench-e2e-projects-')), 'Auth Project');

    launched = await launchApp({ userDataDir, folderDialogPath: projectDir, keepUserDataDir: true });
    const page = launched.window;
    await createProjectWithCalculator(page, server, { expectProjectName: 'Auth Project' });
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
    const preemptive = page.getByTestId('auth-preemptive');
    await expect(preemptive).toBeChecked();
    await preemptive.uncheck();

    await page.getByTestId('request-send').click();
    await expect(page.getByTestId('response-status')).toContainText('200', { timeout: 20_000 });
    await expect(page.getByTestId('response-status')).toContainText('Authenticated after 401 challenge');

    // --- the password never reaches disk in plaintext; only its ref is saved -----------------
    await expect
      .poll(() => listFiles(projectDir!).some((file) => readFileSync(file, 'utf8').includes('passwordRef')), {
        timeout: 15_000,
      })
      .toBe(true);
    for (const file of listFiles(projectDir)) {
      const text = readFileSync(file, 'utf8');
      expect(text, `${file} must not contain the plaintext password`).not.toMatch(/(^|[^a-zA-Z])pass([^a-zA-Z]|$)/);
    }

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
  });
});
