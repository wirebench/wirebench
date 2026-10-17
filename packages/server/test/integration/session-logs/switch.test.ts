import { afterAll, beforeAll, expect, it } from 'vitest';
import type { AuditInput } from '../../../src/context.js';
import { auditLogModule } from '../../../src/audit-log/module.js';
import { sessionLogsModule } from '../../../src/session-logs/module.js';
import { syncModule } from '../../../src/sync/module.js';
import { recordingAudit } from '../../helpers/context.js';
import { describeDb } from '../../helpers/database.js';
import { signedInUser } from '../../helpers/identity.js';
import { license, licenseInstallRecorded, licensingHarness, testKeys } from '../../helpers/licensing.js';
import { call, seedTeam } from '../../helpers/teams.js';

describeDb('the workspace session-log recording switch (#430)', () => {
  const keys = testKeys();
  let h: Awaited<ReturnType<typeof licensingHarness>>;
  let events: AuditInput[];
  let admin: Awaited<ReturnType<typeof signedInUser>>;
  let editor: Awaited<ReturnType<typeof signedInUser>>;
  let teamId: string;
  let workspaceId: string;

  beforeAll(async () => {
    h = await licensingHarness(keys, {
      extra: (clock) => [auditLogModule({ now: () => clock.now }), syncModule(), sessionLogsModule()],
    });
    admin = await signedInUser(h, { email: 'root@example.com', serverAdmin: true });
    editor = await signedInUser(h, { email: 'ed@example.com' });
    const team = await seedTeam(h, { name: 'Ops', admins: [admin], members: [editor] });
    teamId = team.id;
    workspaceId = (await call<{ id: string }>(h, admin, 'POST', `/teams/${teamId}/workspaces`, { name: 'Prod' })).body
      .id;
    await call(h, admin, 'PUT', `/workspaces/${workspaceId}/access/${editor.user.id}`, { role: 'editor' });
    events = recordingAudit(h.hooks);
  });
  afterAll(() => h.close());

  const recording = async (): Promise<boolean> =>
    (await call<{ recordSessionLogs: boolean }>(h, admin, 'GET', `/workspaces/${workspaceId}`)).body.recordSessionLogs;
  const changes = () => events.filter((e) => e.action === 'workspace.session_logs_changed');

  it('meta lists the session-logs capability, and the switch is off by default', async () => {
    const meta = await call<{ capabilities: string[] }>(h, undefined, 'GET', '/meta');
    expect(meta.body.capabilities).toContain('session-logs');
    expect(await recording()).toBe(false);
  });

  it('turning it on needs the session-logs feature', async () => {
    const res = await call<{ code: string }>(h, admin, 'PATCH', `/workspaces/${workspaceId}`, {
      recordSessionLogs: true,
    });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('licensing-feature-required');
    expect(await recording()).toBe(false);
  });

  it('an editor cannot change it', async () => {
    const put = await call(h, admin, 'PUT', '/license', { license: license(keys, { edition: 'enterprise' }) });
    expect(put.status).toBe(200);
    await licenseInstallRecorded(h);
    const res = await call(h, editor, 'PATCH', `/workspaces/${workspaceId}`, { recordSessionLogs: true });
    expect(res.status).toBe(403);
    expect(await recording()).toBe(false);
    expect(changes()).toHaveLength(0);
  });

  it('an admin turns it on: audited with enabled and previous, and the head shows it', async () => {
    const res = await call<{ recordSessionLogs: boolean }>(h, admin, 'PATCH', `/workspaces/${workspaceId}`, {
      recordSessionLogs: true,
    });
    expect(res.status).toBe(200);
    expect(res.body.recordSessionLogs).toBe(true);
    expect(changes()).toEqual([
      expect.objectContaining({
        target: { kind: 'workspace', id: workspaceId },
        workspaceId,
        teamId,
        details: { enabled: true, previous: false },
      }),
    ]);
    const head = await call<{ recordSessionLogs: boolean }>(h, editor, 'GET', `/workspaces/${workspaceId}/sync/head`);
    expect(head.body.recordSessionLogs).toBe(true);
  });

  it('turning it off needs no feature and is audited the other way', async () => {
    await call(h, admin, 'DELETE', '/license');
    const res = await call(h, admin, 'PATCH', `/workspaces/${workspaceId}`, { recordSessionLogs: false });
    expect(res.status).toBe(200);
    expect(changes()[1]!.details).toEqual({ enabled: false, previous: true });
    expect(await recording()).toBe(false);
  });
});
