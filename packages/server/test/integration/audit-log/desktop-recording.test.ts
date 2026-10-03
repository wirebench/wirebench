import { afterAll, beforeAll, expect, it } from 'vitest';
import type { AuditInput } from '../../../src/context.js';
import { auditLogModule } from '../../../src/audit-log/module.js';
import { syncModule } from '../../../src/sync/module.js';
import { recordingAudit } from '../../helpers/context.js';
import { describeDb } from '../../helpers/database.js';
import { signedInUser } from '../../helpers/identity.js';
import { licensingHarness, testKeys } from '../../helpers/licensing.js';
import { call, seedTeam } from '../../helpers/teams.js';

describeDb('the workspace desktop-recording setting (#211)', () => {
  let h: Awaited<ReturnType<typeof licensingHarness>>;
  let events: AuditInput[];
  let admin: Awaited<ReturnType<typeof signedInUser>>;
  let editor: Awaited<ReturnType<typeof signedInUser>>;
  let teamId: string;
  let workspaceId: string;

  beforeAll(async () => {
    h = await licensingHarness(testKeys(), {
      extra: (clock) => [auditLogModule({ now: () => clock.now }), syncModule()],
    });
    events = recordingAudit(h.hooks);
    admin = await signedInUser(h, { email: 'root@example.com', serverAdmin: true });
    editor = await signedInUser(h, { email: 'ed@example.com' });
    const team = await seedTeam(h, { name: 'Ops', admins: [admin], members: [editor] });
    teamId = team.id;
    workspaceId = (await call<{ id: string }>(h, admin, 'POST', `/teams/${teamId}/workspaces`, { name: 'Prod' })).body
      .id;
    await call(h, admin, 'PUT', `/workspaces/${workspaceId}/access/${editor.user.id}`, { role: 'editor' });
  });
  afterAll(() => h.close());

  const recording = async (): Promise<boolean> =>
    (await call<{ recordDesktopActivity: boolean }>(h, admin, 'GET', `/workspaces/${workspaceId}`)).body
      .recordDesktopActivity;
  const changes = () => events.filter((e) => e.action === 'workspace.desktop_recording_changed');

  it('is off by default', async () => {
    expect(await recording()).toBe(false);
  });

  it('an editor cannot change it', async () => {
    const res = await call(h, editor, 'PATCH', `/workspaces/${workspaceId}`, { recordDesktopActivity: true });
    expect(res.status).toBe(403);
    expect(await recording()).toBe(false);
    expect(changes()).toHaveLength(0);
  });

  it('an admin turns it on: the event carries enabled and previous, and the head shows the flag', async () => {
    const res = await call<{ recordDesktopActivity: boolean }>(h, admin, 'PATCH', `/workspaces/${workspaceId}`, {
      recordDesktopActivity: true,
    });
    expect(res.status).toBe(200);
    expect(res.body.recordDesktopActivity).toBe(true);
    expect(changes()).toHaveLength(1);
    expect(changes()[0]).toMatchObject({
      action: 'workspace.desktop_recording_changed',
      target: { kind: 'workspace', id: workspaceId },
      workspaceId,
      teamId,
      details: { enabled: true, previous: false },
    });
    const head = await call<{ recordDesktopActivity: boolean }>(
      h,
      editor,
      'GET',
      `/workspaces/${workspaceId}/sync/head`,
    );
    expect(head.body.recordDesktopActivity).toBe(true);
  });

  it('the same value again writes nothing; turning it off writes the reverse event', async () => {
    await call(h, admin, 'PATCH', `/workspaces/${workspaceId}`, { recordDesktopActivity: true });
    expect(changes()).toHaveLength(1);
    await call(h, admin, 'PATCH', `/workspaces/${workspaceId}`, { recordDesktopActivity: false });
    expect(changes()).toHaveLength(2);
    expect(changes()[1]!.details).toEqual({ enabled: false, previous: true });
    const head = await call<{ recordDesktopActivity: boolean }>(
      h,
      editor,
      'GET',
      `/workspaces/${workspaceId}/sync/head`,
    );
    expect(head.body.recordDesktopActivity).toBe(false);
  });
});
