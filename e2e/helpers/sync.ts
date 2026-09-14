import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Locator, type Page } from '@playwright/test';
import { runCommand } from './palette.js';

/** The badge's `data-state` values (`SyncState` in `shared/wire-types.ts`). */
export type SyncStateName = 'clean' | 'ahead' | 'behind' | 'diverged' | 'conflict' | 'syncing' | 'offline' | 'error';

/** Long enough for a clone or a push on the slowest hosted runner with five apps running. */
const SYNC_TIMEOUT = 60_000;

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

/**
 * Opens the resolver from the conflict banner and keeps the remote's side of every row. The
 * resolver closes itself once the last row is resolved.
 */
export async function keepTheirsForAll(page: Page): Promise<void> {
  await page.getByTestId('sync-banner-resolve').click();
  const resolver = page.getByTestId('conflict-resolver');
  await expect(resolver).toBeVisible();
  const rows = resolver.getByTestId('conflict-resolver-row');
  await expect(rows.first()).toBeVisible({ timeout: SYNC_TIMEOUT });
  for (let remaining = await rows.count(); remaining > 0; remaining -= 1) {
    await rows.first().getByRole('button', { name: 'Keep theirs', exact: true }).click();
    if (remaining > 1) {
      await expect(rows).toHaveCount(remaining - 1, { timeout: SYNC_TIMEOUT });
    }
  }
  await expect(resolver).toBeHidden({ timeout: SYNC_TIMEOUT });
}
