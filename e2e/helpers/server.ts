/**
 * The steps a Wirebench Server spec takes through the app: sign in, share to a team, open a team
 * workspace, and the Sync panel. `server-sync.spec.ts` and `server-live.spec.ts` both drive them, so they
 * live here once.
 */
import { expect, type Locator, type Page } from '@playwright/test';
import type { FakeServer, FakeUser } from './fake-server.js';
import { runCommand } from './palette.js';
import { closeManageWorkspaces, openManageWorkspaces, syncBadge, SYNC_TIMEOUT, waitForSync } from './sync.js';

/** Signs in from wherever the app is (the picker or the IDE) through the palette. */
export async function signIn(page: Page, url: string, user: FakeUser): Promise<void> {
  await runCommand(page, 'Account: Sign in to a server');
  const dialog = page.getByTestId('sign-in-dialog');
  await expect(dialog).toBeVisible({ timeout: 20_000 });
  await dialog.getByTestId('sign-in-url').fill(url);
  await completeSignIn(page, user);
}

/** The rest of an open Sign in dialog whose address is already filled in. */
export async function completeSignIn(page: Page, user: FakeUser): Promise<void> {
  const dialog = page.getByTestId('sign-in-dialog');
  await dialog.getByTestId('sign-in-continue').click();
  await dialog.getByTestId('sign-in-email').fill(user.email);
  await dialog.getByTestId('sign-in-password').fill(user.password);
  await dialog.getByTestId('sign-in-submit').click();
  await expect(dialog).toBeHidden({ timeout: 20_000 });
}

/**
 * *Share this workspace… → Wirebench Server → `team`*. By default this is a new server workspace with its
 * default role left at Viewer; with `existing`, it is that empty server workspace. Waits for the first
 * push to land (`clean`).
 */
export async function shareToTeam(
  page: Page,
  team: string,
  options: { readonly existing?: string } = {},
): Promise<void> {
  const manage = await openManageWorkspaces(page);
  await manage.getByTestId('workspace-share').click();
  const dialog = page.getByTestId('workspace-share-dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByTestId('share-kind-server').check();
  await expect(dialog.getByTestId('share-team').locator('option:checked')).toHaveText(team, { timeout: 20_000 });
  if (options.existing === undefined) {
    await expect(dialog.getByTestId('share-default-role')).toHaveValue('viewer');
  } else {
    await dialog.getByTestId('share-target-existing').check();
    await dialog.getByTestId('share-existing').selectOption({ label: options.existing });
  }
  await dialog.getByTestId('share-confirm').click();
  await expect(dialog).toBeHidden({ timeout: SYNC_TIMEOUT });
  await closeManageWorkspaces(page);
  await expect(syncBadge(page)).toBeVisible({ timeout: SYNC_TIMEOUT });
  await waitForSync(page, 'clean');
}

/** Opens *Open a team workspace…* from the picker and returns the dialog. */
export async function openTeamDialog(page: Page): Promise<Locator> {
  await page.getByTestId('workspace-open-team').click();
  const dialog = page.getByTestId('open-team-workspace-dialog');
  await expect(dialog).toBeVisible();
  return dialog;
}

/** Opens the team workspace `name` from the picker, and waits for the IDE and its badge. */
export async function openTeamWorkspace(page: Page, name: string): Promise<void> {
  const dialog = await openTeamDialog(page);
  await dialog.getByTestId('team-workspace-row').filter({ hasText: name }).click();
  await expect(page.getByTestId('activity-bar')).toBeVisible({ timeout: SYNC_TIMEOUT });
  await expect(dialog).toBeHidden({ timeout: SYNC_TIMEOUT });
  await expect(page.getByTestId('title-bar')).toContainText(name);
  await expect(syncBadge(page)).toBeVisible({ timeout: SYNC_TIMEOUT });
}

/** Opens the Sync panel from the badge and returns it. */
export async function openSyncPanel(page: Page): Promise<Locator> {
  await syncBadge(page).click();
  const panel = page.getByTestId('sync-panel');
  await expect(panel).toBeVisible();
  return panel;
}

/** Closes the Sync panel through its own Close button. */
export async function closeSyncPanel(page: Page): Promise<void> {
  const panel = page.getByTestId('sync-panel');
  await panel.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(panel).toBeHidden();
}

/** Sets *Auto-fetch every N seconds* from the Sync panel, the user's own control, and closes the panel. */
export async function setAutoFetch(page: Page, seconds: number): Promise<void> {
  const panel = await openSyncPanel(page);
  const field = panel.getByLabel('Auto-fetch every N seconds');
  await field.fill(String(seconds));
  await field.press('Enter');
  await expect(field).toHaveValue(String(seconds));
  await closeSyncPanel(page);
}

/** How many `GET …/sync/head` the fake answered for `token`: the fetch timer's heartbeat. */
export function headCalls(fake: FakeServer, token: string): number {
  return fake.requests.filter(
    (request) => request.method === 'GET' && request.path.endsWith('/sync/head') && request.token === token,
  ).length;
}
