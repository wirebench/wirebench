import { expect, test, type Locator } from '@playwright/test';
import {
  PROXY_ONLY_NAME,
  startSshFixture,
  startTestProxy,
  type SshFixture,
  type TestProxy,
} from '@wirebench/ssh/test-helpers';
import { launchApp, type LaunchedApp } from '../helpers/launch-app.js';
import { createWorkspace } from '../helpers/project.js';
import { addPasswordHost, openAdvanced, trustHostKey } from '../helpers/ssh-host.js';

let launched: LaunchedApp | undefined;
let fixture: SshFixture | undefined;
let proxy: TestProxy | undefined;

test.afterEach(async () => {
  try {
    await launched?.close();
  } finally {
    await fixture?.close();
    await proxy?.close();
    launched = undefined;
    fixture = undefined;
    proxy = undefined;
  }
});

/** Sets the host's proxy under Advanced: kind, 127.0.0.1 and the test proxy's port, and a login. */
async function setProxy(
  dialog: Locator,
  kind: 'socks5' | 'http',
  port: number,
  login: { user: string; password: string },
): Promise<void> {
  await openAdvanced(dialog);
  await dialog.getByRole('combobox', { name: 'Proxy', exact: true }).selectOption(kind);
  await dialog.getByLabel('Proxy host', { exact: true }).fill('127.0.0.1');
  await dialog.getByLabel('Proxy port', { exact: true }).fill(String(port));
  await dialog.getByLabel('Proxy user', { exact: true }).fill(login.user);
  await dialog.getByLabel('Proxy password', { exact: true }).fill(login.password);
}

test('a host only a SOCKS5 proxy can reach connects through it', async () => {
  test.setTimeout(180_000);
  fixture = await startSshFixture({ password: { user: 'tester', password: 'pw' } });
  const login = { user: 'corp', password: 'proxy-pw' };
  proxy = await startTestProxy({ type: 'socks5', login });
  launched = await launchApp();
  const page = launched.window;
  await createWorkspace(page, 'Ops');
  const socks = proxy;
  await addPasswordHost(page, fixture, {
    name: 'box',
    beforeSave: async (dialog) => {
      // A name this machine cannot resolve: only the proxy can.
      await dialog.getByLabel('Address', { exact: true }).fill(PROXY_ONLY_NAME);
      await setProxy(dialog, 'socks5', socks.port, login);
    },
  });

  await page.getByTestId('host-row-box').dblclick();
  await trustHostKey(page, fixture);
  await expect(page.getByTestId('connect-screen')).toBeHidden({ timeout: 30_000 });
  await expect(page.getByTestId('editor-area').getByLabel('connected', { exact: true })).toBeVisible();
  // The first-seen key stops the first connect at the trust prompt; Trust dials again, through the proxy too.
  expect(proxy.requests.length).toBeGreaterThan(0);
  for (const request of proxy.requests) expect(request).toEqual({ host: PROXY_ONLY_NAME, port: fixture.port, login });
});

test('an HTTP proxy that refuses the sign-in fails Connecting with a plain sentence, never logging the password', async () => {
  test.setTimeout(180_000);
  fixture = await startSshFixture({ password: { user: 'tester', password: 'pw' } });
  proxy = await startTestProxy({ type: 'http', login: { user: 'corp', password: 'right-proxy-pw' } });
  launched = await launchApp();
  const page = launched.window;
  await createWorkspace(page, 'Ops');
  const http = proxy;
  await addPasswordHost(page, fixture, {
    name: 'box',
    beforeSave: (dialog) => setProxy(dialog, 'http', http.port, { user: 'corp', password: 'wrong-proxy-pw' }),
  });

  await page.getByTestId('host-row-box').dblclick();
  const screen = page.getByTestId('connect-screen');
  await expect(screen).toHaveAttribute('data-state', 'failed', { timeout: 30_000 });
  await expect(page.getByTestId('connect-step-connect')).toHaveAttribute('data-state', 'failed');
  await expect(page.getByTestId('connect-error')).toContainText(
    `The proxy 127.0.0.1:${String(http.port)} refused the sign-in`,
  );
  const log = page.getByTestId('connect-log');
  await expect(log).toContainText(`Connecting through the HTTP proxy 127.0.0.1:${String(http.port)}`);
  await expect(log).toContainText('Asking the proxy as corp for a tunnel');
  await expect(log).not.toContainText('wrong-proxy-pw');
  await expect(log).not.toContainText('right-proxy-pw');
});
