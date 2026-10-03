import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test } from '@playwright/test';
import { environmentRow, openEnvironmentsView, setVariable } from '../helpers/environments.js';
import { launchApp, type LaunchedApp } from '../helpers/launch-app.js';
import { runCommand } from '../helpers/palette.js';
import { createProject, createWorkspace } from '../helpers/project.js';
import {
  addHeader,
  createApi,
  createRestRequest,
  openRequestTab,
  openResponseTab,
  responseStatus,
  sendRest,
  setMethodAndUrl,
} from '../helpers/rest.js';

/** Every request the server saw: its path, its Cookie header and its X-Token header. */
interface Seen {
  readonly path: string;
  readonly cookie: string | undefined;
  readonly token: string | undefined;
}

function headerOf(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value.join(', ') : value;
}

test.describe('Cookie jar and current values (#44)', () => {
  let launched: LaunchedApp | undefined;
  let server: Server | undefined;
  const seen: Seen[] = [];

  test.afterEach(async () => {
    try {
      await launched?.close();
    } finally {
      launched = undefined;
      const open = server;
      server = undefined;
      seen.length = 0;
      await new Promise<void>((resolve) => (open ? open.close(() => resolve()) : resolve()));
    }
  });

  async function startServer(): Promise<string> {
    const created = createServer((request, response) => {
      const path = request.url ?? '';
      seen.push({ path, cookie: headerOf(request, 'cookie'), token: headerOf(request, 'x-token') });
      if (path === '/login') {
        response.writeHead(200, { 'set-cookie': 'sid=abc123; Path=/; HttpOnly', 'content-type': 'text/plain' });
        response.end('logged in');
        return;
      }
      if (path === '/me') {
        const ok = (headerOf(request, 'cookie') ?? '').split(/;\s*/).includes('sid=abc123');
        response.writeHead(ok ? 200 : 401, { 'content-type': 'text/plain' });
        response.end(ok ? 'me' : 'no session');
        return;
      }
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('ok');
    });
    server = created;
    await new Promise<void>((resolve) => created.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(created.address() as AddressInfo).port}`;
  }

  test('a login cookie reaches the next request with Send cookies on, and shows in the manager', async () => {
    const origin = await startServer();
    launched = await launchApp();
    const page = launched.window;
    await createWorkspace(page, 'Cookies');
    await createProject(page, 'Session');
    await createApi(page, 'Site', origin);

    await createRestRequest(page, 'Site', 'Login');
    await setMethodAndUrl(page, 'GET', '/login');
    await sendRest(page);
    await expect(responseStatus(page)).toContainText('200');
    await openResponseTab(page, 'Cookies');
    await expect(page.getByTestId('rest-cookie-jar').first()).toHaveText('stored');

    await createRestRequest(page, 'Site', 'Me');
    await setMethodAndUrl(page, 'GET', '/me');
    // Off by default: the cookie is in the jar but not sent.
    await sendRest(page);
    await expect(responseStatus(page)).toContainText('401');
    expect(seen.at(-1)?.cookie).toBeUndefined();

    await openRequestTab(page, 'Settings');
    await page.getByTestId('rest-setting-send-cookies').check();
    await sendRest(page);
    await expect(responseStatus(page)).toContainText('200');
    expect(seen.at(-1)).toMatchObject({ path: '/me', cookie: 'sid=abc123' });

    // The response pane's link and the command open the same manager tab.
    await openResponseTab(page, 'Cookies');
    await page.getByTestId('rest-cookies-manage').click();
    await expect(page.getByTestId('cookie-manager')).toBeVisible();
    await runCommand(page, 'Show Cookies');
    await expect(page.getByTestId('cookie-manager')).toBeVisible();

    // A row never shows its domain; its group header does.
    await expect(page.getByTestId('cookie-domain-group').filter({ hasText: '127.0.0.1' })).toHaveCount(1);
    const row = page.getByTestId('cookie-row').filter({ hasText: 'sid' });
    await expect(row).toHaveCount(1);
    // The value is masked until asked.
    await expect(row.getByTestId('cookie-value-masked')).toBeVisible();
    await page.getByTestId('cookie-show-values').check();
    await expect(row.getByTestId('cookie-value')).toHaveValue('abc123');
  });

  test('a current value replaces the committed one for the next send, until reset', async () => {
    const origin = await startServer();
    launched = await launchApp();
    const page = launched.window;
    await createWorkspace(page, 'Current');
    await createProject(page, 'Values');
    await createApi(page, 'Site', origin);

    await openEnvironmentsView(page);
    await environmentRow(page, 'Workspace').click();
    await setVariable(page, 'token', 'committed');

    await page.getByRole('button', { name: 'Explorer', exact: true }).click();
    await createRestRequest(page, 'Site', 'Echo');
    await setMethodAndUrl(page, 'GET', '/echo');
    await addHeader(page, 'X-Token', '${token}');
    await sendRest(page);
    await expect(responseStatus(page)).toContainText('200');
    expect(seen.at(-1)?.token).toBe('committed');

    await openEnvironmentsView(page);
    await environmentRow(page, 'Workspace').click();
    const current = page.getByTestId('env-variable-current');
    await expect(current).toHaveAttribute('placeholder', 'committed');
    await current.fill('session-only');
    await current.press('Enter');
    await expect(page.getByTestId('env-variable-current-dot')).toHaveCount(1);
    await expect(page.getByTestId('env-variable-current-reset')).toHaveCount(1);

    await page.getByRole('button', { name: 'Explorer', exact: true }).click();
    await page.getByRole('tab', { name: /Echo/ }).click();
    await sendRest(page);
    await expect.poll(() => seen.at(-1)?.token).toBe('session-only');

    await openEnvironmentsView(page);
    await page.getByRole('tab', { name: /Workspace/ }).click();
    await page.getByTestId('env-variable-current-reset').click();
    await expect(page.getByTestId('env-variable-current-dot')).toHaveCount(0);
    await expect(page.getByTestId('env-variable-current-reset')).toHaveCount(0);

    await page.getByRole('button', { name: 'Explorer', exact: true }).click();
    await page.getByRole('tab', { name: /Echo/ }).click();
    await sendRest(page);
    await expect.poll(() => seen.at(-1)?.token).toBe('committed');
  });
});
