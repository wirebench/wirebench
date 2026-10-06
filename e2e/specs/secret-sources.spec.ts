import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { launchApp, type LaunchedApp } from '../helpers/launch-app.js';
import { createProject, createWorkspace } from '../helpers/project.js';
import {
  addHeader,
  createApi,
  createRestRequest,
  responseStatus,
  saveRequest,
  setMethodAndUrl,
} from '../helpers/rest.js';
import { startTestRestServer, type TestRestServer } from '../helpers/test-server.js';

/** What `e2e/fixtures/fake-vault/vault` prints for `kv/app`. A test value, not a real secret. */
const VAULT_VALUE = 'e2e-vault-value-7731';

/** Every file path under `dir`, recursively (files only). */
function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...listFiles(full));
    } else {
      out.push(full);
    }
  }
  return out;
}

/** The one workspace's folder in the profile. A local workspace's tree is its app-data folder. */
function workspaceFolder(userDataDir: string): string {
  const root = join(userDataDir, 'workspaces');
  const ids = readdirSync(root);
  if (ids.length !== 1) {
    throw new Error(`expected one workspace under ${root}, found ${String(ids.length)}`);
  }
  return join(root, ids[0] as string);
}

/**
 * Secrets from an external manager, end to end (spec: Testing, E2E): a workspace maps `${secret:token}`
 * to a vault entry; the first send is refused until this machine approves the shared mapping; after
 * approval the value reaches the server, History never holds it, and changing the mapping asks again.
 *
 * The vault CLI is a shell script, so the test runs on macOS and Linux. On Windows a tool is found only
 * as an `.exe` (amendment A1), and a script cannot stand in for one. The script sits first on `PATH`;
 * the lookup searches `PATH` before the extra Homebrew directories it tries on macOS, so a real `vault`
 * installed there cannot shadow it.
 */
test.describe('secret sources', () => {
  test.skip(process.platform === 'win32', 'A tool is found only as an .exe on Windows, and a shell script is not one.');

  let launched: LaunchedApp | undefined;
  let rest: TestRestServer | undefined;
  let userDataDir: string | undefined;

  test.afterEach(async () => {
    await launched?.close();
    launched = undefined;
    await rest?.close();
    rest = undefined;
    if (userDataDir !== undefined) {
      rmSync(userDataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
      userDataDir = undefined;
    }
  });

  test('a shared mapping is used after approval, the value stays out of History, and a change asks again', async () => {
    test.setTimeout(180_000);
    rest = await startTestRestServer({ bearerToken: VAULT_VALUE });
    userDataDir = mkdtempSync(join(tmpdir(), 'wirebench-e2e-profile-'));
    launched = await launchApp({
      userDataDir,
      keepUserDataDir: true,
      extraEnv: { PATH: `${resolve('e2e/fixtures/fake-vault')}${delimiter}${process.env['PATH'] ?? ''}` },
    });
    const page = launched.window;
    const toast = page.getByTestId('toast-viewport');

    // --- a REST request whose header uses ${secret:token} -------------------------------------
    await createWorkspace(page, 'Vaulted');
    await createProject(page, 'Pets');
    await createApi(page, 'Petstore', rest.url);
    await createRestRequest(page, 'Petstore', 'Whoami');
    await setMethodAndUrl(page, 'GET', '/auth/bearer');
    await addHeader(page, 'Authorization', 'Bearer ${secret:token}');
    await saveRequest(page);

    // --- the team's mapping arrives in workspace.yaml, as it would from a pull -----------------
    const manifest = join(workspaceFolder(userDataDir), 'workspace.yaml');
    const original = readFileSync(manifest, 'utf8');
    const mapping = 'secretSources:\n  token:\n    kind: vault\n    path: kv/app\n    field: password\n';
    writeFileSync(manifest, `${original.endsWith('\n') ? original : `${original}\n`}${mapping}`);

    // --- send: refused until approved. The send is retried until the watcher has reloaded the file.
    await expect(async () => {
      await page.getByTestId('rest-send').click();
      await expect(toast).toContainText('has not approved', { timeout: 3_000 });
    }).toPass({ timeout: 60_000 });
    expect(rest.requests.filter((request) => request.url === '/auth/bearer')).toHaveLength(0);

    // The toast opens Secret Sources; its banner leads to the approval dialog.
    await toast.getByRole('button', { name: 'Review secret sources…' }).click();
    const sources = page.getByTestId('secret-sources-dialog');
    await expect(sources).toBeVisible({ timeout: 20_000 });
    await sources.getByRole('button', { name: 'Review and approve…' }).click();
    const approval = page.getByTestId('secret-sources-approve-dialog');
    await expect(approval).toBeVisible({ timeout: 20_000 });
    await expect(approval).toContainText('token');
    await expect(approval).toContainText('vault');
    await expect(approval).toContainText('kv/app');
    await approval.getByRole('button', { name: 'Approve' }).click();
    await expect(approval).toBeHidden({ timeout: 20_000 });
    await page.keyboard.press('Escape');
    await expect(sources).toBeHidden({ timeout: 20_000 });

    // --- send again: the vault's value reaches the server ---------------------------------------
    await page.getByTestId('rest-send').click();
    await expect(responseStatus(page)).toContainText('200', { timeout: 20_000 });
    const authorised = rest.requests.filter((request) => request.url === '/auth/bearer');
    expect(authorised.at(-1)?.headers['authorization']).toBe(`Bearer ${VAULT_VALUE}`);

    // --- History holds the send, and never the value --------------------------------------------
    await page.getByTestId('activity-bar').getByRole('button', { name: 'History' }).click();
    await expect(page.getByTestId('history-row').first()).toBeVisible({ timeout: 20_000 });
    expect(await page.locator('body').innerText()).not.toContain(VAULT_VALUE);
    const leaks = listFiles(join(userDataDir, 'workspaces')).filter((file) => readFileSync(file).includes(VAULT_VALUE));
    expect(leaks).toEqual([]);

    // --- the mapping changes on disk: approval is asked again -------------------------------------
    await expect(toast).not.toContainText('has not approved', { timeout: 20_000 });
    writeFileSync(manifest, readFileSync(manifest, 'utf8').replace('path: kv/app', 'path: kv/other'));
    await expect(async () => {
      await page.getByTestId('rest-send').click();
      await expect(toast).toContainText('has not approved', { timeout: 3_000 });
    }).toPass({ timeout: 60_000 });
  });
});
