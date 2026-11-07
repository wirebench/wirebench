/**
 * Team settings and User settings in the browser client (settings split spec §3–§5, §8), against the same
 * stack and seed as `browser-client.spec.ts`: the seeded user is a server admin, an admin of two teams (the
 * second with another admin, an account that is not on the first team).
 *
 * The steps share one page and one session, in order: each builds on the last (the person added, the
 * invitation made and renewed, the team left). Every page reports its CSP violations and the console its
 * errors; the last step asserts there were none.
 */
import { expect, test, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { runCommand } from '../helpers/palette.js';
import { readSeed, type Seed } from './stack.js';

test.describe.configure({ mode: 'serial' });

let seed: Seed;
let context: BrowserContext;
let page: Page;
const violations: string[] = [];
const consoleErrors: string[] = [];
/** Made per run, so a rerun against a stack still up invites afresh. */
const invitee = `browser-e2e-invitee-${Date.now().toString(36)}@example.com`;
/** The first link the invitation had, which *New link* must retire. */
let firstLink = '';

test.beforeAll(async ({ browser }) => {
  seed = readSeed();
  context = await browser.newContext();
  await context.exposeBinding('__wirebenchCspViolation', (_source, line: string) => {
    violations.push(line);
  });
  await context.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (event) => {
      const report = (window as unknown as { __wirebenchCspViolation: (line: string) => Promise<void> })
        .__wirebenchCspViolation;
      void report(
        `${event.violatedDirective} blocked ${event.blockedURI} at ${event.sourceFile}:${String(event.lineNumber)}`,
      );
    });
  });
  page = await context.newPage();
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(`${page.url()}: ${message.text()}`);
  });
  page.on('pageerror', (error) => {
    consoleErrors.push(`${page.url()}: uncaught ${error.message}`);
  });

  await page.goto('/');
  await expect(page).toHaveURL(/\/sign-in\?redirect_to=/);
  await page.locator('#email').fill(seed.email);
  await page.locator('#password').fill(seed.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId('workspace-open-team')).toBeVisible({ timeout: 60_000 });
});

test.afterAll(async () => {
  await context.close();
});

function settings(): Locator {
  return page.getByTestId('team-settings');
}

/** Picks `teamId` in the switcher and waits for the address to name it. */
async function switchTo(teamId: string, name: string): Promise<void> {
  await settings().getByTestId('team-switcher').click();
  await page.getByTestId(`team-switcher-${teamId}`).click();
  await expect(settings().getByTestId('team-switcher')).toContainText(name);
  await expect(page).toHaveURL(new RegExp(`[?&]team=${teamId}&`));
}

function memberRow(email: string): Locator {
  return settings().locator('[data-testid^="member-row-"]').filter({ hasText: email });
}

function invitationRow(email: string): Locator {
  return settings().locator('[data-testid^="invitation-row-"]').filter({ hasText: email });
}

test('the team link opens Team settings on People and keeps the address', async () => {
  await page.goto('/?panel=team');
  await expect(settings()).toBeVisible({ timeout: 60_000 });
  await expect(settings().getByTestId('team-settings-nav-people')).toHaveAttribute('aria-current', 'page');
  await expect(page).toHaveURL(/[?&]panel=team&team=[A-Za-z0-9_-]+&page=people/);
});

test('switching team keeps the page and the address follows', async () => {
  await switchTo(seed.teamId, seed.teamName);
  await settings().getByTestId('team-settings-nav-workspaces').click();
  await expect(page).toHaveURL(new RegExp(`[?&]team=${seed.teamId}&page=workspaces`));
  await switchTo(seed.secondTeamId, seed.secondTeamName);
  await expect(settings().getByTestId('team-settings-nav-workspaces')).toHaveAttribute('aria-current', 'page');
  await expect(page).toHaveURL(new RegExp(`[?&]team=${seed.secondTeamId}&page=workspaces`));

  // Back to the first team, on People, for the steps that follow.
  await switchTo(seed.teamId, seed.teamName);
  await settings().getByTestId('team-settings-nav-people').click();
  await expect(page).toHaveURL(new RegExp(`[?&]team=${seed.teamId}&page=people`));
});

test('adding a person with an account makes them a member', async () => {
  await settings().getByTestId('people-add').click();
  const dialog = page.getByTestId('add-people-dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByTestId('add-people-email').fill(seed.existingEmail);
  await dialog.getByTestId('add-people-submit').click();
  await expect(dialog.getByTestId('add-people-result')).toHaveText(`Added ${seed.existingEmail} to ${seed.teamName}.`);
  await expect(dialog.getByTestId('add-people-link')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Done' }).click();
  await expect(dialog).toBeHidden();
  await expect(memberRow(seed.existingEmail)).toBeVisible();
});

test('adding an email without an account makes an invitation and shows its link once', async () => {
  await settings().getByTestId('people-add').click();
  const dialog = page.getByTestId('add-people-dialog');
  await dialog.getByTestId('add-people-email').fill(invitee);
  await dialog.getByTestId('add-people-submit').click();
  await expect(dialog.getByTestId('add-people-result')).toContainText('so this is an invitation');
  await expect(dialog.getByTestId('add-people-link')).toHaveValue(/\/invite\//);
  firstLink = await dialog.getByTestId('add-people-link').inputValue();
  await dialog.getByRole('button', { name: 'Done' }).click();
  await expect(dialog).toBeHidden();
  await expect(invitationRow(invitee)).toContainText('Invited as Member');
  // Shown once: nothing on the page holds the link any more.
  await expect(page.getByTestId('add-people-link')).toHaveCount(0);
});

test('New link replaces the link; the old one no longer opens the invitation', async () => {
  await invitationRow(invitee).locator('[data-testid^="invitation-renew-"]').click();
  const dialog = page.getByTestId('add-people-dialog');
  await expect(dialog.getByTestId('add-people-link')).toHaveValue(/\/invite\//);
  const newLink = await dialog.getByTestId('add-people-link').inputValue();
  expect(newLink).not.toBe(firstLink);
  await dialog.getByRole('button', { name: 'Done' }).click();
  await expect(dialog).toBeHidden();
  await expect(invitationRow(invitee)).toHaveCount(1);

  // The invitation page, in a tab of its own: the old link is closed, the new one offers the accept form.
  const tab = await context.newPage();
  try {
    await tab.goto(firstLink);
    await expect(tab.getByText('This invitation has expired or was already used.')).toBeVisible();
    await expect(tab.locator('#password')).toHaveCount(0);
    await tab.goto(newLink);
    await expect(tab.getByText(invitee)).toBeVisible();
    await expect(tab.getByRole('button', { name: 'Create account and sign in' })).toBeVisible();
  } finally {
    await tab.close();
  }
});

test('Revoke removes the invitation', async () => {
  await invitationRow(invitee).locator('[data-testid^="invitation-revoke-"]').click();
  await expect(invitationRow(invitee)).toHaveCount(0);
});

// The seeded user is a server admin, who sees every team on the server: leaving takes them off the team's
// People list, and the team stays in the switcher, with its other admin still on it.
test('leaving a team takes you off its People list; a server admin still sees the team', async () => {
  await switchTo(seed.secondTeamId, seed.secondTeamName);
  await expect(settings().getByTestId('team-settings-nav-people')).toHaveAttribute('aria-current', 'page');
  await settings().getByTestId('member-leave').click();
  await expect(page.getByText(`Leave ${seed.secondTeamName}?`)).toBeVisible();
  await page.getByTestId('member-remove-confirm-ok').click();
  await expect(settings().getByTestId('member-leave')).toHaveCount(0);
  await expect(memberRow(seed.existingEmail)).toBeVisible();
  await expect(settings().getByTestId('team-switcher')).toContainText(seed.secondTeamName);
  // Back on the first team for the tests after this one.
  await switchTo(seed.teamId, seed.teamName);
});

test('as a server admin, a reload on a Server page stays on it', async () => {
  await settings().getByTestId('team-settings-nav-sign-in').click();
  await expect(settings().getByTestId('server-page-sign-in')).toBeVisible();
  await expect(page).toHaveURL(/[?&]page=sign-in/);
  await page.reload();
  await expect(settings()).toBeVisible({ timeout: 60_000 });
  await expect(settings().getByTestId('server-page-sign-in')).toBeVisible();
  await expect(settings().getByTestId('team-settings-nav-sign-in')).toHaveAttribute('aria-current', 'page');
  await expect(page).toHaveURL(/[?&]page=sign-in/);
});

test('User settings shows your profile and renames you', async () => {
  // Back to the workspace first: the palette belongs to it.
  await settings().getByTestId('settings-back').click();
  await expect(settings()).toHaveCount(0);
  await expect(page).not.toHaveURL(/panel=team/);

  await runCommand(page, 'Account: Account settings');
  const user = page.getByTestId('user-settings');
  await expect(user).toBeVisible({ timeout: 20_000 });
  await expect(user.getByTestId('user-profile-email')).toHaveValue(seed.email);
  const name = user.getByTestId('user-profile-name');
  await expect(name).toHaveValue('Browser E2E');
  await name.fill('Browser E2E renamed');
  await name.press('Enter');
  await expect(user.getByTestId('user-profile-name-error')).toHaveCount(0);

  // The server kept it: a fresh read after leaving and coming back shows the new name.
  await page.keyboard.press('Escape');
  await expect(user).toHaveCount(0);
  await runCommand(page, 'Account: Account settings');
  await expect(page.getByTestId('user-profile-name')).toHaveValue('Browser E2E renamed', { timeout: 20_000 });
  await page.keyboard.press('Escape');
});

test('no page broke its CSP or logged an error along the way', () => {
  expect(violations).toEqual([]);
  expect(consoleErrors).toEqual([]);
});
