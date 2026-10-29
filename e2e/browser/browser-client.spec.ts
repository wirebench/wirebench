/**
 * The browser client end to end (hosted edition spec §17.7): a signed-in tab opens a server workspace,
 * sends to a service on the server's network, is refused a loopback address by the egress rule, shows
 * no SSH area and no file-manager reveal, and signs out to the sign-in page.
 *
 * The steps share one page and one session, in order: each builds on the last, and the sign-in
 * endpoints are rate-limited per address. Every page the flow loads reports its CSP violations and the
 * console reports its errors; the last step asserts there were none.
 */
import { expect, test, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { openTeamDialog } from '../helpers/server.js';
import { apiRow, responseStatus, restRequestRow, sendRest, unfoldRow } from '../helpers/rest.js';
import { readSeed, type Seed } from './stack.js';

test.describe.configure({ mode: 'serial' });

// Read in the worker, after global setup has seeded the server; the runner loads this file before that.
let seed: Seed;
let context: BrowserContext;
let page: Page;
/** What the pages reported: `securitypolicyviolation` events, console errors and uncaught errors. */
const violations: string[] = [];
const consoleErrors: string[] = [];

test.beforeAll(async ({ browser }) => {
  seed = readSeed();
  context = await browser.newContext();
  // A binding outlives navigations, so a violation on the sign-in page counts as much as one in the app.
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
});

test.afterAll(async () => {
  await context.close();
});

function projectRow(): Locator {
  return page.getByTestId('explorer-project-row').filter({ hasText: seed.projectName });
}

async function openRequest(name: string): Promise<void> {
  await unfoldRow(projectRow());
  await unfoldRow(apiRow(page, seed.apiName));
  await restRequestRow(page, name).click();
  await expect(page.getByTestId('rest-editor')).toBeVisible();
  await expect(page.getByTestId('rest-breadcrumb-name')).toHaveText(name);
}

test('a tab without a session is sent to sign in, and a local password signs it in', async () => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/sign-in\?redirect_to=%2F$|\/sign-in\?redirect_to=\/$/);
  await page.locator('#email').fill(seed.email);
  await page.locator('#password').fill(seed.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/$/);
  // The browser opens server workspaces only: the picker offers that and nothing that needs files.
  await expect(page.getByTestId('workspace-open-team')).toBeVisible({ timeout: 60_000 });
  // What needs local files (the `files` capability) is not offered: no new or imported workspace, no
  // project folders from before.
  for (const testId of ['workspace-create-name', 'workspace-create', 'workspace-import-folder']) {
    await expect(page.getByTestId(testId)).toHaveCount(0);
  }
  await expect(page.getByText('Project folders you opened before')).toHaveCount(0);
});

test('opens the seeded server workspace', async () => {
  const dialog = await openTeamDialog(page);
  await dialog.getByTestId('team-workspace-row').filter({ hasText: seed.workspaceName }).click();
  await expect(dialog).toBeHidden({ timeout: 60_000 });
  await expect(page.getByTestId('activity-bar')).toBeVisible();
  await expect(projectRow()).toBeVisible();
});

test('the SSH area and the file-manager reveal are absent', async () => {
  // The rail's SSH entry (`activity-hosts`) needs the `ssh` capability, which the browser host lacks.
  const rail = page.getByTestId('activity-bar');
  await expect(rail).toBeVisible();
  await expect(page.getByTestId('activity-hosts')).toHaveCount(0);
  // The rail itself is there with its other areas, so the absence above is the SSH area's alone.
  const areas = rail.locator('[data-testid^="activity-"]:not([data-testid="activity-settings"])');
  expect(await areas.count()).toBeGreaterThan(0);

  // The project's context menu: its New ▸ submenu is there, its Reveal is not (`files`).
  await projectRow().click({ button: 'right' });
  const menu = page.getByRole('menu');
  await expect(menu.getByRole('menuitem', { name: 'New', exact: true })).toBeVisible();
  await expect(
    menu.getByRole('menuitem', { name: /Reveal in Finder|Reveal in Explorer|Show in file manager/ }),
  ).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
});

test('a request to the echo service on the server network gets its response', async () => {
  await openRequest(seed.echoRequest);
  await sendRest(page);
  await expect(responseStatus(page)).toContainText('200');
  await expect(page.getByTestId('rest-response')).toContainText('/hello');
});

test('a request to 127.0.0.1 is refused by the egress rule', async () => {
  await openRequest(seed.loopbackRequest);
  await page.getByTestId('rest-send').click();
  const panel = page.getByTestId('send-error-panel');
  await expect(panel).toBeVisible();
  // The code sits in the panel's folded details; its text is there either way.
  await expect(panel.getByTestId('send-error-code')).toHaveText('egress-refused');
});

test('signing out lands on the sign-in page, and the app is no longer served', async () => {
  // The status bar's account menu: in a tab its one *Sign out* ends the session (`env.signOut`, a form
  // post to `/sign-out` from the page, so the browser sends the page's own Origin).
  await page.getByTestId('status-bar-account').click();
  await page.getByTestId('account-sign-out').click();
  // The server answers the post with `/sign-in`; the tab's host socket, closed 4401 by the same sign-out,
  // may send the page there first with its way back (`?redirect_to=%2F`). Either is the sign-in page.
  await expect(page).toHaveURL(/\/sign-in(\?redirect_to=%2F)?$/);
  await expect(page.locator('#email')).toBeVisible();
  await page.goto('/');
  await expect(page).toHaveURL(/\/sign-in\?redirect_to=/);
});

test('no page broke its CSP or logged an error along the way', () => {
  expect(violations).toEqual([]);
  expect(consoleErrors).toEqual([]);
});
