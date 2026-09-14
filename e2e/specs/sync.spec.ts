import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { setMonacoText } from '../helpers/editor.js';
import { environmentRow, openEnvironment, openEnvironmentsView, setVariable } from '../helpers/environments.js';
import {
  ADA,
  createBareRemote,
  gitConfigEnv,
  remoteContains,
  remoteFiles,
  remoteHead,
  remoteLog,
  treeHead,
} from '../helpers/git-remote.js';
import { launchApp, removeDirSync, type LaunchedApp } from '../helpers/launch-app.js';
import {
  createProjectWithCalculator,
  expandExplorer,
  expectExplorerRow,
  openFirstRequest,
  saveAll,
  workspaceProjectDir,
} from '../helpers/project.js';
import {
  awaitConflict,
  calculatorEnvelope,
  envelopeText,
  joinWorkspace,
  keepTheirsForAll,
  pullNow,
  pushNow,
  sharedProjectDir,
  sharedTreeDir,
  shareWorkspace,
  stopSharingWorkspace,
  syncBadge,
  waitForSync,
} from '../helpers/sync.js';
import { startTestSoapServer, type TestSoapServer } from '../helpers/test-server.js';

/**
 * Shared workspaces end to end, across two profiles on one machine: profile A shares a workspace
 * to a bare git remote in a temp folder, profile B joins it by URL, and the two exchange edits
 * through push and pull — an environment, a conflicting request body resolved in the app, and a
 * secret ref whose value stays behind on A.
 *
 * Git is hermetic: both apps and every git call made here read a throwaway global config
 * (`gitConfigEnv`), so neither the developer's nor the runner's identity or settings leak in.
 * Each test builds its own remote and both profiles from scratch.
 */

const GIT_ENV = gitConfigEnv(ADA);
const SYNC_TIMEOUT = 60_000;

/** Every file under `dir`, keyed by its path relative to `dir`, with its bytes as base64. */
function snapshotFiles(dir: string, root = dir, out = new Map<string, string>()): Map<string, string> {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      snapshotFiles(full, root, out);
    } else {
      out.set(relative(root, full), readFileSync(full).toString('base64'));
    }
  }
  return out;
}

/** The values of every variable row on the open environment page. */
async function variableValues(page: Page): Promise<string[]> {
  const inputs = page.getByTestId('env-variable-value');
  const values: string[] = [];
  for (let index = 0, count = await inputs.count(); index < count; index += 1) {
    values.push(await inputs.nth(index).inputValue());
  }
  return values;
}

test.describe('shared workspaces', () => {
  test.describe.configure({ mode: 'serial' });

  let appA: LaunchedApp | undefined;
  let appB: LaunchedApp | undefined;
  let server: TestSoapServer | undefined;
  let remote: { dir: string; url: string } | undefined;
  let dirs: string[] = [];

  test.beforeEach(async () => {
    test.setTimeout(180_000);
    server = await startTestSoapServer({ fixture: 'calculator', respondToCalculatorAdd: true });
    remote = await createBareRemote();
    dirs.push(remote.dir);
  });

  test.afterEach(async () => {
    // Both apps close even when the first close fails (a console error, an app already gone);
    // the first failure is rethrown once everything is cleaned up.
    const failures: unknown[] = [];
    for (const app of [appA, appB]) {
      if (app !== undefined) {
        await app.close().catch((error: unknown) => failures.push(error));
      }
    }
    appA = undefined;
    appB = undefined;
    await server?.close();
    server = undefined;
    remote = undefined;
    for (const dir of dirs) {
      removeDirSync(dir);
    }
    dirs = [];
    if (failures.length > 0) {
      throw failures[0];
    }
  });

  /** A fresh profile on the hermetic git config; its folder is removed in `afterEach`. */
  async function launchProfile(): Promise<LaunchedApp> {
    const userDataDir = mkdtempSync(join(tmpdir(), 'wirebench-e2e-sync-'));
    dirs.push(userDataDir);
    return await launchApp({ userDataDir, keepUserDataDir: true, extraEnv: GIT_ENV });
  }

  /** Profile A: Workspace 1 with the calculator project, saved, shared to the remote, pushed. */
  async function shareFromA(): Promise<LaunchedApp> {
    appA = await launchProfile();
    const page = appA.window;
    await createProjectWithCalculator(page, server!);
    await saveAll(page);
    await shareWorkspace(page, remote!.url);
    await expect.poll(() => remoteLog(remote!.dir), { timeout: SYNC_TIMEOUT }).toContain('Share workspace Workspace 1');
    return appA;
  }

  /** Profile B: joins the remote from the picker. */
  async function joinInB(): Promise<LaunchedApp> {
    appB = await launchProfile();
    await joinWorkspace(appB.window, remote!.url);
    await waitForSync(appB.window, 'clean');
    return appB;
  }

  /** Waits until `app`'s tree is at the remote's `main` — the pull (or push) has landed. */
  async function expectTreeAtRemote(app: LaunchedApp): Promise<void> {
    await expect
      .poll(() => treeHead(sharedTreeDir(app.userDataDir)), { timeout: SYNC_TIMEOUT })
      .toBe(remoteHead(remote!.dir));
  }

  test('sharing pushes the tree, a second profile joins it, and stopping sharing keeps the project', async () => {
    const a = await shareFromA();

    // --- the remote holds the tree, and nothing machine-local -----------------------------
    const files = remoteFiles(remote!.dir);
    expect(files).toContain('workspace.yaml');
    expect(files).toContain('.gitattributes');
    expect(files.some((file) => file.startsWith('projects/'))).toBe(true);
    expect(files.filter((file) => file.startsWith('unsaved/'))).toEqual([]);
    expect(files.filter((file) => file === 'local.yaml' || file.endsWith('/local.yaml'))).toEqual([]);
    expect(files).not.toContain('share.yaml');
    // A shared workspace keeps its projects inside the tree, so linking a folder is disabled.
    await expect(a.window.getByTestId('explorer-link-project')).toBeDisabled();

    // --- B joins: same project, stored under <id>/tree/projects ---------------------------
    const b = await joinInB();
    await expect(b.window.getByTestId('title-bar')).toContainText('Workspace 1');
    await expectExplorerRow(
      b.window.getByTestId('explorer-project-row').filter({ hasText: 'Calculator Project' }),
      b.window,
    );
    const projectDir = sharedProjectDir(b.userDataDir);
    const segments = relative(join(b.userDataDir, 'workspaces'), projectDir).split(sep);
    expect(segments).toHaveLength(4);
    expect(segments.slice(1, 3)).toEqual(['tree', 'projects']);
    expect(existsSync(join(projectDir, 'wirebench.yaml'))).toBe(true);

    // --- B stops sharing: still lists the project, no badge, files back in <id>/projects ----
    await stopSharingWorkspace(b.window);
    await expect(syncBadge(b.window)).toHaveCount(0);
    await expectExplorerRow(
      b.window.getByTestId('explorer-project-row').filter({ hasText: 'Calculator Project' }),
      b.window,
    );
    expect(existsSync(join(workspaceProjectDir(b.userDataDir), 'wirebench.yaml'))).toBe(true);
  });

  test('an environment edited in one profile arrives in the other by pull', async () => {
    const ENV_VALUE = 'eu-west-e2e-7731';
    const a = await shareFromA();
    const b = await joinInB();

    // --- A adds `dev` with a variable; saving an environment commits and pushes -------------
    await openEnvironmentsView(a.window);
    await a.window.getByRole('button', { name: 'Add environment' }).click();
    const created = environmentRow(a.window, 'Environment 1');
    await expect(created).toBeVisible();
    await created.click({ button: 'right' });
    await a.window.getByRole('menuitem', { name: 'Rename' }).click();
    await a.window.getByLabel('Rename Environment 1').fill('dev');
    await a.window.getByLabel('Rename Environment 1').press('Enter');
    await expect(environmentRow(a.window, 'dev')).toBeVisible();
    await setVariable(a.window, 'region', ENV_VALUE);
    await expect.poll(() => remoteContains(remote!.dir, ENV_VALUE), { timeout: SYNC_TIMEOUT }).toBe(true);
    await waitForSync(a.window, 'clean');

    // --- B pulls: the environment and its value show, with no changed-on-disk banner ---------
    await pullNow(b.window);
    await expectTreeAtRemote(b);
    await waitForSync(b.window, 'clean');
    await openEnvironmentsView(b.window);
    await expect(environmentRow(b.window, 'dev')).toBeVisible({ timeout: 20_000 });
    await openEnvironment(b.window, 'dev');
    await expect.poll(() => variableValues(b.window), { timeout: 20_000 }).toContain(ENV_VALUE);
    await expect(b.window.locator('[data-testid^="changed-on-disk-banner"]')).toHaveCount(0);
  });

  test('the same request edited in both profiles conflicts, and keeping theirs converges both', async () => {
    const MARKER_A = '1111';
    const MARKER_B = '2222';
    const a = await shareFromA();
    const b = await joinInB();

    for (const page of [a.window, b.window]) {
      await expandExplorer(page, 'Request 1');
      await openFirstRequest(page);
    }

    // --- both edit intA; B's edit stays unsaved while A saves (commit + push) -----------------
    await setMonacoText(b.window, 'Request envelope XML', calculatorEnvelope(MARKER_B));
    await expect(b.window.getByTestId('editor-tab-dirty')).toHaveCount(1, { timeout: 10_000 });
    await setMonacoText(a.window, 'Request envelope XML', calculatorEnvelope(MARKER_A));
    await expect(a.window.getByTestId('editor-tab-dirty')).toHaveCount(1, { timeout: 10_000 });
    await saveAll(a.window);
    await expect
      .poll(() => remoteContains(remote!.dir, `<tem:intA>${MARKER_A}</tem:intA>`), { timeout: SYNC_TIMEOUT })
      .toBe(true);

    // --- B saves: its push is rejected, the pull that follows conflicts -----------------------
    await saveAll(b.window);
    await awaitConflict(b.window);
    await expect(b.window.getByTestId('sync-banner-conflicts')).toBeVisible();
    await expect(b.window.getByTestId('request-conflict-note')).toBeVisible({ timeout: 20_000 });

    // --- B keeps theirs: the editor shows A's text, and B pushes the merge ---------------------
    await keepTheirsForAll(b.window);
    await expect.poll(() => envelopeText(b.window), { timeout: 20_000 }).toContain(`<tem:intA>${MARKER_A}</tem:intA>`);
    await expect(b.window.getByTestId('request-conflict-note')).toHaveCount(0, { timeout: 20_000 });
    await pushNow(b.window);
    await waitForSync(b.window, 'clean');
    await expect
      .poll(() => remoteHead(remote!.dir), { timeout: SYNC_TIMEOUT })
      .toBe(treeHead(sharedTreeDir(b.userDataDir)));

    // --- A's next pull is clean and lands on the same commit ----------------------------------
    await pullNow(a.window);
    await expectTreeAtRemote(a);
    await waitForSync(a.window, 'clean');
    await expect(a.window.getByTestId('request-conflict-note')).toHaveCount(0);
    expect(await envelopeText(a.window)).toContain(`<tem:intA>${MARKER_A}</tem:intA>`);
  });

  test('a secret set in one profile is "Not on this machine" in the other until entered there', async () => {
    const PASSWORD = 'pass';
    const a = await shareFromA();
    const b = await joinInB();

    // --- A: Basic auth on the first request, against the fixture's /auth/basic ---------------
    const pageA = a.window;
    await expandExplorer(pageA, 'Request 1');
    await openFirstRequest(pageA);
    await pageA.getByTestId('request-endpoint').fill(`${server!.url}/auth/basic`);
    await pageA.getByRole('tablist', { name: 'Request inspectors' }).getByRole('tab', { name: 'Auth' }).click();
    const panelA = pageA.getByTestId('inspector-panel-request');
    await pageA.getByTestId('auth-inherit').uncheck();
    await panelA.getByLabel('Authentication type').selectOption('basic');
    await panelA.getByLabel('Username').fill('user');
    await panelA.getByRole('button', { name: 'Set…' }).click();
    await panelA.getByPlaceholder('Enter password').fill(PASSWORD);
    await panelA.getByRole('button', { name: 'Save' }).click();
    await expect(panelA.getByLabel('Password')).toHaveText('••••••••');
    await saveAll(pageA);
    await expect.poll(() => remoteContains(remote!.dir, '/auth/basic'), { timeout: SYNC_TIMEOUT }).toBe(true);
    await expect.poll(() => remoteContains(remote!.dir, 'passwordRef'), { timeout: SYNC_TIMEOUT }).toBe(true);

    // --- B pulls and opens the request: the ref arrived, the value did not ---------------------
    const pageB = b.window;
    await pullNow(pageB);
    await expectTreeAtRemote(b);
    await expandExplorer(pageB, 'Request 1');
    await openFirstRequest(pageB);
    await expect(pageB.getByTestId('request-endpoint')).toHaveValue(/\/auth\/basic$/, { timeout: 20_000 });
    await pageB.getByRole('tablist', { name: 'Request inspectors' }).getByRole('tab', { name: 'Auth' }).click();
    const panelB = pageB.getByTestId('inspector-panel-request');
    await expect(panelB.getByTestId('secret-missing')).toHaveText('Not on this machine', { timeout: 20_000 });

    // Sending now fails in words that say where to act.
    await pageB.getByTestId('request-send').click();
    await expect(
      pageB
        .getByText('The password for "user" is not on this machine — enter it in the authentication settings.')
        .first(),
    ).toBeVisible({ timeout: 20_000 });

    // --- B enters the value: same ref, so the shared project files do not change -------------
    const projectDir = sharedProjectDir(b.userDataDir);
    const before = snapshotFiles(projectDir);
    await panelB.getByRole('button', { name: 'Enter…' }).click();
    await panelB.getByPlaceholder('Enter password').fill(PASSWORD);
    await panelB.getByRole('button', { name: 'Save' }).click();
    await expect(panelB.getByLabel('Password')).toHaveText('••••••••');
    await expect(panelB.getByTestId('secret-missing')).toHaveCount(0);

    await pageB.getByTestId('request-send').click();
    await expect(pageB.getByTestId('response-status')).toContainText('200', { timeout: 20_000 });
    expect([...snapshotFiles(projectDir)]).toEqual([...before]);
  });
});
