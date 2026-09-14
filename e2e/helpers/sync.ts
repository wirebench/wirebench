import { existsSync, mkdtempSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, sep } from 'node:path';
import { expect, type Locator, type Page } from '@playwright/test';
import { setMonacoText } from './editor.js';
import { environmentRow, openEnvironmentsView, setVariable } from './environments.js';
import { ADA, gitConfigEnv, remoteContains, remoteLog, type GitIdentity } from './git-remote.js';
import { launchApp, removeDirSync, type LaunchedApp } from './launch-app.js';
import { runCommand } from './palette.js';
import { createProjectWithCalculator, expandExplorer, openFirstRequest, saveAll } from './project.js';
import type { TestSoapServer } from './test-server.js';

/** The badge's `data-state` values (`SyncState` in `shared/wire-types.ts`). */
export type SyncStateName = 'clean' | 'ahead' | 'behind' | 'diverged' | 'conflict' | 'syncing' | 'offline' | 'error';

/** Long enough for a clone or a push on the slowest hosted runner with five apps running. */
export const SYNC_TIMEOUT = 60_000;

/**
 * The profiles (and temp folders) one sync test launches, closed and removed together by
 * {@link dispose} even when one of them fails to close — so a spec's `afterEach` never leaves an
 * app running or a folder behind, and still reports the first failure.
 */
export class SyncProfiles {
  private readonly apps: LaunchedApp[] = [];
  private readonly dirs: string[] = [];

  /** Registers a temp folder to remove on {@link dispose}; returns it. */
  track(dir: string): string {
    this.dirs.push(dir);
    return dir;
  }

  /**
   * Launches a fresh profile on the hermetic git config for `identity` (default Ada; `null` for
   * none), plus any `extraEnv` and a pinned folder-picker answer.
   */
  async launch(
    options: {
      readonly identity?: GitIdentity | null;
      readonly extraEnv?: Readonly<Record<string, string>>;
      readonly folderDialogPath?: string;
    } = {},
  ): Promise<LaunchedApp> {
    const userDataDir = this.track(mkdtempSync(join(tmpdir(), 'wirebench-e2e-sync-')));
    const app = await launchApp({
      userDataDir,
      keepUserDataDir: true,
      ...(options.folderDialogPath !== undefined ? { folderDialogPath: options.folderDialogPath } : {}),
      extraEnv: { ...gitConfigEnv(options.identity === undefined ? ADA : options.identity), ...options.extraEnv },
    });
    this.apps.push(app);
    return app;
  }

  /** Closes every app (collecting failures), removes every folder, then rethrows the first failure. */
  async dispose(): Promise<void> {
    const failures: unknown[] = [];
    for (const app of this.apps.splice(0)) {
      await app.close().catch((error: unknown) => {
        failures.push(error);
      });
    }
    for (const dir of this.dirs.splice(0)) {
      removeDirSync(dir);
    }
    if (failures.length > 0) {
      throw failures[0];
    }
  }
}

/** The status bar's sync badge; absent while the open workspace is not shared. */
export function syncBadge(page: Page): Locator {
  return page.getByTestId('status-bar-sync');
}

/**
 * Waits until the sync badge reports `state` (or a state matching the pattern). Keyed on
 * `data-state`, never on the label: the label carries a relative time that ticks every 30 s.
 */
export async function waitForSync(page: Page, state: SyncStateName | RegExp, timeout = SYNC_TIMEOUT): Promise<void> {
  await expect(syncBadge(page)).toHaveAttribute('data-state', state, { timeout });
}

/** Opens *Manage workspaces…* from the title bar's workspace switcher and returns the dialog. */
export async function openManageWorkspaces(page: Page): Promise<Locator> {
  await page.getByTestId('workspace-switcher').click();
  await page.getByRole('menuitem', { name: 'Manage workspaces…' }).click();
  const dialog = page.getByTestId('workspace-manage-dialog');
  await expect(dialog).toBeVisible();
  return dialog;
}

/** Closes the *Manage workspaces* dialog through its own Close button. */
export async function closeManageWorkspaces(page: Page): Promise<void> {
  const dialog = page.getByTestId('workspace-manage-dialog');
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(dialog).toBeHidden();
}

/** The id of the open workspace as the app itself knows it (the manage dialog's row for it). */
export async function openWorkspaceId(page: Page): Promise<string> {
  const manage = await openManageWorkspaces(page);
  const id = await manage.getByTestId('workspace-rename-name').first().getAttribute('data-workspace-id');
  await closeManageWorkspaces(page);
  expect(id).not.toBeNull();
  return id as string;
}

export interface ShareWorkspaceOptions {
  /**
   * The badge state to wait for once sharing returned (default `clean`). `null` waits for
   * nothing and leaves the manage dialog open — for a flow where another dialog (the identity
   * one) opens on top of it and must be dealt with first.
   */
  readonly waitForState?: SyncStateName | null;
}

/**
 * Shares the open local workspace as a git repository pushing to `remoteUrl`: manage dialog →
 * *Share this workspace…* → Git repository → remote → Share. Main resolves the share only after
 * the first commit and push were attempted, so once the dialog has closed the remote holds the
 * tree (or the badge holds the reason it does not).
 */
export async function shareWorkspace(
  page: Page,
  remoteUrl: string,
  options: ShareWorkspaceOptions = {},
): Promise<void> {
  const manage = await openManageWorkspaces(page);
  await manage.getByTestId('workspace-share').click();
  const dialog = page.getByTestId('workspace-share-dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByTestId('share-kind-git').check();
  await dialog.getByTestId('share-remote').fill(remoteUrl);
  await expect(dialog.getByTestId('share-branch')).toHaveValue('main');
  await dialog.getByTestId('share-confirm').click();
  await expect(dialog).toBeHidden({ timeout: SYNC_TIMEOUT });
  const waitFor = options.waitForState === undefined ? 'clean' : options.waitForState;
  if (waitFor === null) {
    return;
  }
  await closeManageWorkspaces(page);
  await expect(syncBadge(page)).toBeVisible({ timeout: SYNC_TIMEOUT });
  await waitForSync(page, waitFor);
}

/**
 * Joins the workspace at `remoteUrl` from the workspace picker (a fresh profile starts there):
 * *Join shared workspace…* → remote → Join, then waits for the IDE and its sync badge.
 */
export async function joinWorkspace(page: Page, remoteUrl: string): Promise<void> {
  await page.getByTestId('workspace-join').click();
  const dialog = page.getByTestId('workspace-join-dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByTestId('join-remote').fill(remoteUrl);
  await expect(dialog.getByTestId('join-branch')).toHaveValue('main');
  await dialog.getByTestId('join-confirm').click();
  await expect(page.getByTestId('activity-bar')).toBeVisible({ timeout: SYNC_TIMEOUT });
  await expect(dialog).toBeHidden({ timeout: SYNC_TIMEOUT });
  await expect(syncBadge(page)).toBeVisible({ timeout: SYNC_TIMEOUT });
}

/** *Sync: Pull* through the command palette (fetch, then merge). */
export async function pullNow(page: Page): Promise<void> {
  await runCommand(page, 'Sync: Pull');
}

/** *Sync: Push* through the command palette. */
export async function pushNow(page: Page): Promise<void> {
  await runCommand(page, 'Sync: Push');
}

/** The environment {@link addActiveEnvironment} creates. */
export const ENVIRONMENT_NAME = 'Environment 1';

/**
 * Adds a workspace environment holding `variable = value` and makes it the active one, which
 * writes the machine-local `local.yaml`. Leaves the Explorer view showing.
 */
export async function addActiveEnvironment(page: Page, variable: string, value: string): Promise<void> {
  await openEnvironmentsView(page);
  await page.getByRole('button', { name: 'Add environment' }).click();
  await expect(environmentRow(page, ENVIRONMENT_NAME)).toBeVisible();
  // "Add environment" already opened this environment's page.
  await setVariable(page, variable, value);
  await page.getByTestId('env-switcher').click();
  await page.getByRole('menuitem', { name: ENVIRONMENT_NAME, exact: true }).click();
  await expect(page.getByTestId('env-switcher')).toContainText(ENVIRONMENT_NAME);
  await page.getByRole('button', { name: 'Explorer', exact: true }).click();
}

/**
 * Profile A's start: Workspace 1 with the calculator project (plus whatever `beforeShare` adds),
 * saved, shared to `remote`, and the share commit on the remote.
 */
export async function startSharedWorkspace(
  page: Page,
  server: TestSoapServer,
  remote: { readonly dir: string; readonly url: string },
  options: { readonly beforeShare?: (page: Page) => Promise<void> } = {},
): Promise<void> {
  await createProjectWithCalculator(page, server);
  if (options.beforeShare !== undefined) {
    await options.beforeShare(page);
  }
  await saveAll(page);
  await shareWorkspace(page, remote.url);
  await expect.poll(() => remoteLog(remote.dir), { timeout: SYNC_TIMEOUT }).toContain('Share workspace Workspace 1');
}

/** Profile B's start: joins `remoteUrl` from the picker and waits for a clean sync. */
export async function joinSharedWorkspace(page: Page, remoteUrl: string): Promise<void> {
  await joinWorkspace(page, remoteUrl);
  await waitForSync(page, 'clean');
}

/** Stops sharing the open workspace from the manage dialog, confirming, and waits for the badge to go. */
export async function stopSharingWorkspace(page: Page): Promise<void> {
  const manage = await openManageWorkspaces(page);
  await manage.getByTestId('workspace-stop-sharing').click();
  await page.getByTestId('workspace-stop-sharing-confirm').click();
  await expect(syncBadge(page)).toHaveCount(0, { timeout: SYNC_TIMEOUT });
  await expect(manage.getByTestId('workspace-share')).toBeVisible({ timeout: SYNC_TIMEOUT });
  await closeManageWorkspaces(page);
}

/**
 * The tree of the profile's one shared workspace with a managed tree:
 * `<userDataDir>/workspaces/<id>/tree`. Throws unless exactly one exists.
 */
export function sharedTreeDir(userDataDir: string): string {
  const root = join(userDataDir, 'workspaces');
  const found = (existsSync(root) ? readdirSync(root) : [])
    .map((workspace) => join(root, workspace, 'tree'))
    .filter((tree) => existsSync(join(tree, 'workspace.yaml')));
  if (found.length !== 1) {
    throw new Error(`expected one shared workspace tree under ${root}, found ${String(found.length)}`);
  }
  return found[0] as string;
}

/** The workspace id a managed tree lives under: the `<id>` of `<userDataDir>/workspaces/<id>/tree`. */
export function sharedWorkspaceId(userDataDir: string): string {
  return basename(dirname(sharedTreeDir(userDataDir)));
}

/**
 * The tree-aware sibling of `workspaceProjectDir`: a project folder inside a shared workspace's
 * managed tree, `<userDataDir>/workspaces/<id>/tree/projects/<slug>`. With no `slug`, the tree
 * must hold exactly one project.
 */
export function sharedProjectDir(userDataDir: string, slug?: string): string {
  const projects = join(sharedTreeDir(userDataDir), 'projects');
  const found = (existsSync(projects) ? readdirSync(projects) : [])
    .filter((project) => slug === undefined || project === slug)
    .map((project) => join(projects, project));
  if (found.length !== 1) {
    throw new Error(
      `expected one project folder under ${projects}${slug === undefined ? '' : ` named ${slug}`}, found ${String(found.length)}`,
    );
  }
  return found[0] as string;
}

/**
 * Every file in a working tree except its `.git`, as sorted `/`-separated relative paths — the
 * same shape `git ls-tree -r --name-only` reports, so the two compare directly on every OS.
 */
export function treeFiles(tree: string): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (dir === tree && name === '.git') {
        continue;
      }
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else {
        files.push(relative(tree, full).split(sep).join('/'));
      }
    }
  };
  walk(tree);
  return files.sort();
}

/** The calculator `Add` envelope with `intA` set to `intA` — the line two profiles fight over. */
export function calculatorEnvelope(intA: string): string {
  return [
    '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tem="http://tempuri.org/">',
    '   <soapenv:Header/>',
    '   <soapenv:Body>',
    '      <tem:Add>',
    `         <tem:intA>${intA}</tem:intA>`,
    '         <tem:intB>2</tem:intB>',
    '      </tem:Add>',
    '   </soapenv:Body>',
    '</soapenv:Envelope>',
  ].join('\n');
}

/** The open request editor's rendered text, whitespace removed (as `unsaved-across-sessions.spec.ts` reads it). */
export async function envelopeText(page: Page): Promise<string> {
  const lines = await page
    .locator('[aria-label="Request envelope XML"]')
    .locator('xpath=ancestor::*[contains(@class, "monaco-editor")][1]')
    .locator('.view-line')
    .allTextContents();
  return lines.join('').replace(/\s| /g, '');
}

/**
 * After a save that is bound to collide with the remote: waits for the conflict. A save commits
 * and pushes; a rejected push pulls by itself, which is what normally lands here. Should the push
 * instead end as `diverged` or `error`, an explicit pull gets to the same merge.
 */
export async function awaitConflict(page: Page): Promise<void> {
  await waitForSync(page, /^(conflict|diverged|error)$/);
  if ((await syncBadge(page).getAttribute('data-state')) !== 'conflict') {
    await pullNow(page);
  }
  await waitForSync(page, 'conflict');
}

/** The intA the pushing profile (A, "theirs" to B) saves in {@link produceRequestConflict}. */
export const CONFLICT_THEIRS = '1111';
/** The intA the conflicting profile (B, "mine") saves in {@link produceRequestConflict}. */
export const CONFLICT_MINE = '2222';

/**
 * Two profiles on the same shared workspace edit the first request's intA: B's edit stays
 * unsaved while A saves {@link CONFLICT_THEIRS} (commit + push, polled on the remote), then B
 * saves {@link CONFLICT_MINE} and lands in `conflict`. Both requests are left open.
 */
export async function produceRequestConflict(pageA: Page, pageB: Page, remoteDir: string): Promise<void> {
  for (const page of [pageA, pageB]) {
    await expandExplorer(page, 'Request 1');
    await openFirstRequest(page);
  }
  await setMonacoText(pageB, 'Request envelope XML', calculatorEnvelope(CONFLICT_MINE));
  await expect(pageB.getByTestId('editor-tab-dirty')).toHaveCount(1, { timeout: 10_000 });
  await setMonacoText(pageA, 'Request envelope XML', calculatorEnvelope(CONFLICT_THEIRS));
  await expect(pageA.getByTestId('editor-tab-dirty')).toHaveCount(1, { timeout: 10_000 });
  await saveAll(pageA);
  await expect
    .poll(() => remoteContains(remoteDir, `<tem:intA>${CONFLICT_THEIRS}</tem:intA>`), { timeout: SYNC_TIMEOUT })
    .toBe(true);
  await saveAll(pageB);
  await awaitConflict(pageB);
}

/** Opens the resolver from the conflict banner and returns it once its first row shows. */
export async function openConflictResolver(page: Page): Promise<Locator> {
  await page.getByTestId('sync-banner-resolve').click();
  const resolver = page.getByTestId('conflict-resolver');
  await expect(resolver).toBeVisible();
  await expect(resolver.getByTestId('conflict-resolver-row').first()).toBeVisible({ timeout: SYNC_TIMEOUT });
  return resolver;
}

/** In the open resolver, keeps the remote's side of every row; the resolver closes itself after the last. */
export async function keepTheirsForAll(page: Page): Promise<void> {
  const resolver = page.getByTestId('conflict-resolver');
  const rows = resolver.getByTestId('conflict-resolver-row');
  for (let remaining = await rows.count(); remaining > 0; remaining -= 1) {
    await rows.first().getByTestId('conflict-resolver-theirs').click();
    if (remaining > 1) {
      await expect(rows).toHaveCount(remaining - 1, { timeout: SYNC_TIMEOUT });
    }
  }
  await expect(resolver).toBeHidden({ timeout: SYNC_TIMEOUT });
}
