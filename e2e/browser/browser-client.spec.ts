/**
 * The browser client end to end (hosted edition spec §17.7, §18.7): a signed-in tab opens a server
 * workspace, sends to a service on the server's network, finds that a loopback address needs this
 * machine, pairs the headless `wirebench agent` running beside it (global setup starts it, unpaired) and
 * sends to this machine's `127.0.0.1` through it, sees in History which host sent each exchange, shows no
 * SSH area and no file-manager reveal, and signs out to the sign-in page.
 *
 * The steps share one page and one session, in order: each builds on the last, and the sign-in
 * endpoints are rate-limited per address. Every page the flow loads reports its CSP violations and the
 * console reports its errors; the last step asserts there were none.
 */
import { expect, test, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { openTeamDialog } from '../helpers/server.js';
import { apiRow, responseStatus, restRequestRow, sendRest, unfoldRow } from '../helpers/rest.js';
import { pairAgent, unpairAgent } from './agent.js';
import { BASE_URL, readAgentHome, readSeed, type Seed } from './stack.js';

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
  // A retry starts from an unpaired machine, as the first attempt did: the loopback step expects no agent.
  await unpairAgent(readAgentHome());
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

test('a request to 127.0.0.1 needs this machine: the tab has no agent, so it offers to pair one', async () => {
  await openRequest(seed.loopbackRequest);
  // The route chip says where the next send goes before it is sent (spec §18.4).
  await expect(page.getByTestId('send-route-chip')).toHaveText('Agent');
  await page.getByTestId('rest-send').click();
  const panel = page.getByTestId('send-error-panel');
  await expect(panel).toBeVisible();
  // The person's localhost is never the server's: nothing went out from the server, and with no agent
  // paired the send stops here. The code sits in the panel's folded details; its text is there either way.
  await expect(panel.getByTestId('send-error-code')).toHaveText('send-needs-agent');
  // The offer leads to Settings → This machine, where the next step pairs.
  await page.getByRole('button', { name: 'Pair this machine…' }).click();
  await expect(page.getByTestId('this-machine-section')).toBeVisible();
});

test('pairs the headless agent on this machine with the code This machine shows', async () => {
  const section = page.getByTestId('this-machine-section');
  await section.getByTestId('agent-pair').click();
  // The command the tab offers is the one to run: its code, and the server's origin as the tab sees it,
  // which is the origin the agent then checks every socket's Origin against.
  const command = (await section.getByTestId('agent-pair-code').locator('code').innerText()).trim();
  const typed = /^wirebench agent pair (\S+) --server (\S+)$/.exec(command);
  expect(typed, `the offered command: ${command}`).not.toBeNull();
  const [, code, server] = typed as unknown as [string, string, string];
  expect(server).toBe(BASE_URL);

  const out = await pairAgent(readAgentHome(), code, server);
  expect(out).toContain(`Paired with ${BASE_URL} as ${seed.email}.`);

  // The section reads the pairings again while the code is out, and the tab opens its socket to the agent.
  await expect(section.getByTestId('agent-pairing-row').first()).toBeVisible({ timeout: 30_000 });
  await expect(section.getByTestId('agent-status')).toHaveAttribute('data-status', 'connected', { timeout: 60_000 });
  await section.getByTestId('agent-pair-done').click();
  // Settings takes the whole window while open: leave it before touching the explorer.
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('settings-page')).toHaveCount(0);
});

test('a request to this machine’s 127.0.0.1 goes out through the paired agent', async () => {
  await openRequest(seed.agentRequest);
  await expect(page.getByTestId('send-route-chip')).toHaveText('Agent');
  await sendRest(page);
  await expect(responseStatus(page)).toContainText('200');
  // Only this machine's echo server answers this: the server's 127.0.0.1 is its own container.
  await expect(page.getByTestId('rest-response')).toContainText(seed.agentPath);
});

test('History says which host sent each exchange: the agent, or the server', async () => {
  await page.getByTestId('activity-bar').getByRole('button', { name: 'History' }).click();
  const rows = page.getByTestId('history-row');
  // A row shows the request's path or its name, depending on the History view.
  const agentRow = rows.filter({ hasText: new RegExp(`${seed.agentPath}|${seed.agentRequest}`) }).first();
  const serverRow = rows.filter({ hasText: new RegExp(`/hello|${seed.echoRequest}`) }).first();
  await expect(agentRow.getByTestId('history-origin')).toHaveAttribute('data-origin', 'agent');
  await expect(serverRow.getByTestId('history-origin')).toHaveAttribute('data-origin', 'server');
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
