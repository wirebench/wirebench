import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { startFakeServer, type AuditEvent, type FakeServer, type FakeUser } from '../helpers/fake-server.js';
import { launchApp, type LaunchedApp } from '../helpers/launch-app.js';
import { runCommand } from '../helpers/palette.js';
import { signIn } from '../helpers/server.js';

const PASSWORD = 'correct horse battery';
const ROOT: FakeUser = { email: 'root@example.com', password: PASSWORD, displayName: 'Root', serverAdmin: true };
const ENTERPRISE = `wbl1.${Buffer.from(
  JSON.stringify({
    id: '01J9ZK3V8Q0000000000000000',
    customer: 'Example AG',
    edition: 'enterprise',
    seats: null,
    issuedAt: '2026-09-01T00:00:00Z',
    expiresAt: '2099-09-01T00:00:00Z',
  }),
).toString('base64url')}.c2lnbmF0dXJl`;
const now = Date.now();
const EVENTS: AuditEvent[] = [0, 1, 2].map((i) => ({
  id: `01J9ZK3V8Q000000000000000${String(i)}`,
  at: new Date(now - i * 60_000).toISOString(),
  actor: { kind: 'user', userId: 'U1', email: 'alice@example.com' },
  action: i === 1 ? 'team.created' : 'auth.signed_in',
  target: i === 1 ? { kind: 'team', id: 'T1' } : { kind: 'user', id: 'U1' },
  workspaceId: null,
  teamId: i === 1 ? 'T1' : null,
  ip: '203.0.113.7',
  userAgent: 'Wirebench/3.1.0',
  details: i === 1 ? { name: 'Payments' } : { method: 'local', device: 'laptop' },
}));

test.describe('audit log (audit-log spec §3.6)', () => {
  let launched: LaunchedApp | undefined;
  let server: FakeServer | undefined;
  let userDataDir = '';
  let exportPath = '';

  test.beforeEach(() => {
    userDataDir = mkdtempSync(join(tmpdir(), 'wirebench-e2e-audit-'));
    exportPath = join(userDataDir, 'audit.ndjson');
  });
  test.afterEach(async () => {
    await launched?.close();
    launched = undefined;
    await server?.close();
    server = undefined;
    rmSync(userDataDir, { recursive: true, force: true });
  });

  test('gated on Community; filters, opens a detail and exports on Enterprise', async () => {
    test.setTimeout(120_000);
    server = await startFakeServer({ users: [ROOT], auditEvents: EVENTS });
    launched = await launchApp({
      userDataDir,
      keepUserDataDir: true,
      extraEnv: { WIREBENCH_E2E_DIALOG_SAVE: exportPath },
    });
    const page = launched.window;
    await signIn(page, server.url, ROOT);
    await runCommand(page, 'Account: Manage teams');
    const dialog = page.getByTestId('team-dialog');
    await expect(dialog).toBeVisible({ timeout: 20_000 });
    await dialog.getByRole('tab', { name: 'Audit' }).click();
    await expect(dialog.getByTestId('audit-gated')).toBeVisible();

    await dialog.getByRole('tab', { name: 'License' }).click();
    await dialog.getByTestId('license-input').fill(ENTERPRISE);
    await dialog.getByTestId('license-install').click();
    await expect(dialog.getByTestId('license-edition')).toHaveText('Enterprise');

    await dialog.getByRole('tab', { name: 'Audit' }).click();
    await expect(dialog.getByTestId('audit-row')).toHaveCount(3);
    await dialog.getByTestId('audit-group').selectOption('team');
    await expect(dialog.getByTestId('audit-row')).toHaveCount(1);
    await dialog.getByTestId('audit-row').first().click();
    await expect(dialog.getByTestId('audit-detail')).toContainText('alice@example.com');
    await expect(dialog.getByTestId('audit-details-json')).toContainText('"name": "Payments"');

    await dialog.getByTestId('audit-export').click();
    await expect.poll(() => readFileSync(exportPath, 'utf8').trim().split('\n').length).toBe(1);
    expect(server.requests.some((r) => r.method === 'GET' && r.path.startsWith('/api/v1/audit/export'))).toBe(true);
  });
});
