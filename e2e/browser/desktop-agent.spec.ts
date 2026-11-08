/**
 * Success criterion 2 of the hosted edition (spec §13.2, with §18 on the local agent), with the desktop app
 * as the agent: a signed-in tab opens the server workspace and sends to the echo service from the server,
 * pairs the built desktop app (launched on the Electron binary, see `desktop-app.ts`) through its *Pair this
 * machine…* with the code the tab's *This machine* shows, and sends to this machine's `127.0.0.1` through
 * the desktop's agent. The server's own History, read over the tab's host socket (`history.list`), then says
 * the one went out from the server and the other from the agent.
 *
 * `browser-client.spec.ts` runs the same flow with the headless `wirebench agent`, which global setup keeps
 * running here; this spec unpairs it first, so the only agent the tab may reach is the desktop's. The steps
 * share one page, one session and one app, in order.
 */
import { expect, test, type BrowserContext, type Locator, type Page } from '@playwright/test';
import type { LaunchedPackagedApp } from '../helpers/launch-app.js';
import { appReady, openTeamDialog } from '../helpers/server.js';
import { apiRow, responseStatus, restRequestRow, sendRest, unfoldRow } from '../helpers/rest.js';
import { ensureUnpaired } from './agent.js';
import {
  DESKTOP_REQUIRED,
  desktopBuilt,
  launchDesktop,
  openPairedBrowsers,
  pairDesktop,
  unpairDesktop,
} from './desktop-app.js';
import { BASE_URL, readAgentHome, readSeed, type Seed } from './stack.js';

test.describe.configure({ mode: 'serial' });

// CI builds the desktop app and sets WIREBENCH_E2E_REQUIRE_DESKTOP, so there the spec never skips.
test.skip(!DESKTOP_REQUIRED && !desktopBuilt(), 'the desktop app is not built: run pnpm build first');

let seed: Seed;
let context: BrowserContext;
let page: Page;
let desktop: LaunchedPackagedApp | undefined;
/** The history entries already there before this spec sent anything (another spec's, or a retry's). */
let earlier: ReadonlySet<string> = new Set();

interface HistoryRow {
  readonly id: string;
  readonly requestName: string;
  readonly endpoint: string;
  readonly status?: number;
  readonly sentFrom?: 'server' | 'agent';
}

/** The server's History of the open workspace, through the tab's own host socket. */
async function serverHistory(): Promise<HistoryRow[]> {
  const result = await page.evaluate(async () => {
    const api = (
      window as unknown as {
        wirebench: { history: { list(request: object): Promise<{ ok: boolean; value?: { entries: HistoryRow[] } }> } };
      }
    ).wirebench.history;
    return await api.list({ limit: 200 });
  });
  expect(result.ok, 'history.list answered').toBe(true);
  return result.value?.entries ?? [];
}

/** The user's pairings as the server holds them, read with the tab's cookie. */
async function serverPairings(): Promise<{ id: string; port: number }[]> {
  return await page.evaluate(async () => {
    const answer = await fetch('/api/v1/agent/pairings', { credentials: 'same-origin' });
    const body = (await answer.json()) as { pairings?: { id: string; port: number }[] };
    return body.pairings ?? [];
  });
}

/** Unpairs every pairing of the user at the server: what an earlier attempt or the CLI agent left. */
async function clearServerPairings(): Promise<void> {
  await page.evaluate(async () => {
    const answer = await fetch('/api/v1/agent/pairings', { credentials: 'same-origin' });
    const body = (await answer.json()) as { pairings?: { id: string }[] };
    for (const pairing of body.pairings ?? []) {
      await fetch(`/api/v1/agent/pairings/${encodeURIComponent(pairing.id)}`, {
        method: 'DELETE',
        credentials: 'same-origin',
      });
    }
  });
}

test.beforeAll(async ({ browser }) => {
  seed = readSeed();
  // The headless agent stays running, but unpaired: the tab must reach this machine through the desktop.
  await ensureUnpaired(readAgentHome());
  context = await browser.newContext();
  page = await context.newPage();
});

test.afterAll(async () => {
  try {
    if (desktop !== undefined) await unpairDesktop(desktop.window);
    // Anything the desktop could not unpair itself, so a retry's tab starts with no pairing.
    const opened = page as Page | undefined;
    if (opened !== undefined && !opened.url().includes('/sign-in')) {
      await clearServerPairings().catch(() => undefined);
    }
    await (context as BrowserContext | undefined)?.close();
  } finally {
    await desktop?.close();
  }
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

test('signs in at a browser tab and opens the seeded server workspace', async () => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/sign-in\?redirect_to=/);
  await page.locator('#identifier').fill(seed.email);
  await page.locator('#password').fill(seed.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(appReady(page)).toBeVisible({ timeout: 60_000 });
  // No pairing from an earlier attempt: the desktop's is the only one this spec makes.
  await clearServerPairings();
  expect(await serverPairings()).toEqual([]);

  const dialog = await openTeamDialog(page, seed.teamName);
  await dialog.getByTestId('team-workspace-row').filter({ hasText: seed.workspaceName }).click();
  // browser-client.spec.ts joined this workspace as the same user, so the server's host already holds
  // its checkout: the dialog then offers to open that one instead of joining again.
  const alreadyPresent = dialog.getByTestId('open-team-workspace-already-present');
  // The tab may have reopened another workspace (#879), so the IDE being up says nothing: wait for the dialog to
  // offer the existing copy, or to close on its own.
  await expect
    .poll(async () => (await alreadyPresent.isVisible()) || !(await dialog.isVisible()), { timeout: 60_000 })
    .toBe(true);
  if (await alreadyPresent.isVisible()) {
    await dialog.getByTestId('open-team-workspace-open-existing').click();
  }
  await expect(dialog).toBeHidden({ timeout: 60_000 });
  await expect(projectRow()).toBeVisible();
  earlier = new Set((await serverHistory()).map((entry) => entry.id));
});

test('a public request goes out from the server', async () => {
  await openRequest(seed.echoRequest);
  await sendRest(page);
  await expect(responseStatus(page)).toContainText('200');
  await expect(page.getByTestId('rest-response')).toContainText('/hello');
});

test('the desktop app pairs with the code the tab’s This machine shows', async () => {
  desktop = await launchDesktop();
  await openPairedBrowsers(desktop.window);
  await expect(desktop.window.getByTestId('machine-agent-status')).toHaveText(
    'Off: it starts when this machine is paired',
  );

  await page.getByTestId('activity-settings').click();
  await page.getByTestId('settings-nav-this-machine').click();
  const section = page.getByTestId('this-machine-section');
  await expect(section).toBeVisible();
  await section.getByTestId('agent-pair').click();
  const command = (await section.getByTestId('agent-pair-code').locator('code').innerText()).trim();
  const typed = /^wirebench agent pair (\S+) --server (\S+)$/.exec(command);
  expect(typed, `the offered command: ${command}`).not.toBeNull();
  const [, code, server] = typed as unknown as [string, string, string];
  expect(server).toBe(BASE_URL);

  // The desktop takes the same two things the command carries: the server's address and the code.
  await pairDesktop(desktop.window, server, code);
  const status = desktop.window.getByTestId('machine-agent-status');
  await expect(status).toHaveText(/^Listening on port \d+$/, { timeout: 30_000 });
  const port = Number(/(\d+)$/.exec(await status.innerText())?.[1]);
  await expect(desktop.window.getByTestId('machine-agent-pairing')).toContainText(`${BASE_URL} · ${seed.email}`);

  // The server holds exactly the desktop's pairing, on the port its agent listens on (it took the next free
  // one beside the headless agent and told the server so).
  await expect.poll(serverPairings, { timeout: 30_000 }).toEqual([expect.objectContaining({ port })]);
  await expect(section.getByTestId('agent-pairing-row')).toHaveCount(1, { timeout: 30_000 });
  await expect(section.getByTestId('agent-status')).toHaveAttribute('data-status', 'connected', { timeout: 60_000 });
  await section.getByTestId('agent-pair-done').click();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('settings-page')).toHaveCount(0);
});

test('a request to this machine’s 127.0.0.1 goes out through the desktop app’s agent', async () => {
  await openRequest(seed.agentRequest);
  await expect(page.getByTestId('send-route-chip')).toHaveText('Agent');
  await sendRest(page);
  await expect(responseStatus(page)).toContainText('200');
  // Only this machine's echo server answers this: the server's 127.0.0.1 is its own container.
  await expect(page.getByTestId('rest-response')).toContainText(seed.agentPath);
  await expect(page.getByTestId('rest-response')).toContainText(/"echo":\s*"local"/);
});

test('the server’s History records which host sent each exchange', async () => {
  // Read from the server's records, not the History view: the entries this spec's two sends added.
  const fresh = async (): Promise<HistoryRow[]> => (await serverHistory()).filter((entry) => !earlier.has(entry.id));
  await expect
    .poll(async () => (await fresh()).map((entry) => entry.requestName).sort(), { timeout: 30_000 })
    .toEqual([seed.agentRequest, seed.echoRequest].sort());
  const entries = await fresh();
  const fromServer = entries.find((entry) => entry.requestName === seed.echoRequest);
  const fromAgent = entries.find((entry) => entry.requestName === seed.agentRequest);
  expect(fromServer).toMatchObject({ sentFrom: 'server', status: 200 });
  expect(fromServer?.endpoint).toContain('/hello');
  expect(fromAgent).toMatchObject({ sentFrom: 'agent', status: 200 });
  expect(fromAgent?.endpoint).toContain(`127.0.0.1:`);
  expect(fromAgent?.endpoint).toContain(seed.agentPath);

  // And the History view says the same.
  await page.getByTestId('activity-bar').getByRole('button', { name: 'History' }).click();
  const rows = page.getByTestId('history-row');
  const agentRow = rows.filter({ hasText: new RegExp(`${seed.agentPath}|${seed.agentRequest}`) }).first();
  await expect(agentRow.getByTestId('history-origin')).toHaveAttribute('data-origin', 'agent');
});
