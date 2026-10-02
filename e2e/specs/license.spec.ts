import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { startFakeServer, type FakeServer, type FakeUser } from '../helpers/fake-server.js';
import { launchApp, type LaunchedApp } from '../helpers/launch-app.js';
import { runCommand } from '../helpers/palette.js';
import { signIn } from '../helpers/server.js';

const PASSWORD = 'correct horse battery';
const ROOT: FakeUser = { email: 'root@example.com', password: PASSWORD, displayName: 'Root', serverAdmin: true };
const ALICE: FakeUser = { email: 'alice@example.com', password: PASSWORD, displayName: 'Alice' };
const BOB: FakeUser = { email: 'bob@example.com', password: PASSWORD, displayName: 'Bob' };

/** Well-formed, so main's shared-schema check passes; the fake does not verify signatures. */
const LICENSE = `wbl1.${Buffer.from(
  JSON.stringify({
    id: '01J9ZK3V8Q0000000000000000',
    customer: 'Example AG',
    edition: 'team',
    seats: 50,
    issuedAt: '2026-09-01T00:00:00Z',
    expiresAt: '2099-09-01T00:00:00Z',
  }),
).toString('base64url')}.c2lnbmF0dXJl`;

test.describe('server license (licensing spec §3.8)', () => {
  let launched: LaunchedApp | undefined;
  let server: FakeServer | undefined;
  let userDataDir = '';

  test.beforeEach(() => {
    userDataDir = mkdtempSync(join(tmpdir(), 'wirebench-e2e-license-'));
  });
  test.afterEach(async () => {
    await launched?.close();
    launched = undefined;
    await server?.close();
    server = undefined;
    rmSync(userDataDir, { recursive: true, force: true });
  });

  test('a server admin with no team pastes a Team license and the seat limit lifts', async () => {
    test.setTimeout(120_000);
    server = await startFakeServer({ users: [ROOT, ALICE, BOB] });
    launched = await launchApp({ userDataDir, keepUserDataDir: true });
    const page = launched.window;
    await signIn(page, server.url, ROOT);

    await runCommand(page, 'Account: Manage teams');
    const dialog = page.getByTestId('team-dialog');
    await expect(dialog).toBeVisible({ timeout: 20_000 });
    await expect(dialog.getByRole('tab', { name: 'License' })).toBeVisible();
    await expect(dialog.getByTestId('license-edition')).toHaveText('Community');
    await expect(dialog.getByTestId('license-seats')).toHaveText('3 of 5 seats in use');

    await dialog.getByTestId('license-input').fill(LICENSE);
    await dialog.getByTestId('license-install').click();
    await expect(dialog.getByTestId('license-edition')).toHaveText('Team');
    await expect(dialog.getByTestId('license-seats')).toHaveText('3 of 50 seats in use');
    await expect(dialog.getByTestId('license-input')).toHaveValue('');
    expect(server.requests.some((r) => r.method === 'PUT' && r.path === '/api/v1/license')).toBe(true);
  });
});
