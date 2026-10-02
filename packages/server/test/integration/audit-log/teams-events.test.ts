import { afterAll, beforeAll, expect, it } from 'vitest';
import type { AuditInput } from '../../../src/context.js';
import { auditLogModule } from '../../../src/audit-log/module.js';
import { expectNoSecretsInAudit, recordingAudit } from '../../helpers/context.js';
import { describeDb } from '../../helpers/database.js';
import { signedInUser } from '../../helpers/identity.js';
import { licensingHarness, testKeys } from '../../helpers/licensing.js';
import { call, seedTeam } from '../../helpers/teams.js';

const last = (events: AuditInput[], action: AuditInput['action']) => events.filter((e) => e.action === action).at(-1)!;

describeDb('teams-access fire sites (audit-log spec §3.2, plan ruling 7)', () => {
  let h: Awaited<ReturnType<typeof licensingHarness>>;
  let events: AuditInput[];
  let admin: Awaited<ReturnType<typeof signedInUser>>;
  let member: Awaited<ReturnType<typeof signedInUser>>;

  beforeAll(async () => {
    // licensingHarness already registers teams-access, so migrations run 0001 to 0008 with no gap.
    // Actions go through the routes, not the seed helpers: the seeds write rows directly and fire nothing.
    h = await licensingHarness(testKeys(), { extra: (clock) => [auditLogModule({ now: () => clock.now })] });
    events = recordingAudit(h.hooks);
    admin = await signedInUser(h, { email: 'root@example.com', serverAdmin: true });
    member = await signedInUser(h, { email: 'm@example.com' });
  });
  afterAll(() => h.close());

  it('team created, renamed with the previous name, member added, role changed, removed, deleted with its name', async () => {
    const team = (await call<{ id: string }>(h, admin, 'POST', '/teams', { name: 'Payments' })).body;
    expect(last(events, 'team.created')).toMatchObject({
      target: { kind: 'team', id: team.id },
      teamId: team.id,
      details: { name: 'Payments' },
    });
    await call(h, admin, 'PATCH', `/teams/${team.id}`, { name: 'Billing' });
    expect(last(events, 'team.renamed').details).toEqual({ name: 'Billing', previousName: 'Payments' });
    await call(h, admin, 'POST', `/teams/${team.id}/members`, { email: 'm@example.com', role: 'member' });
    expect(last(events, 'team.member_added')).toMatchObject({
      target: { kind: 'user', id: member.user.id },
      teamId: team.id,
      details: { role: 'member' },
    });
    await call(h, admin, 'PATCH', `/teams/${team.id}/members/${member.user.id}`, { role: 'admin' });
    expect(last(events, 'team.member_role_changed').details).toEqual({ role: 'admin', previousRole: 'member' });
    await call(h, admin, 'DELETE', `/teams/${team.id}/members/${member.user.id}`);
    expect(last(events, 'team.member_removed').details).toEqual({ role: 'admin', self: false });
    await call(h, admin, 'DELETE', `/teams/${team.id}`);
    expect(last(events, 'team.deleted').details).toEqual({ name: 'Billing' });
  });

  it('workspace created, renamed, default role changed, grant set and removed with the role, deleted with name and team', async () => {
    const team = await seedTeam(h, { name: 'Ops', admins: [admin] });
    const ws = (await call<{ id: string }>(h, admin, 'POST', `/teams/${team.id}/workspaces`, { name: 'Prod' })).body;
    expect(last(events, 'workspace.created')).toMatchObject({
      target: { kind: 'workspace', id: ws.id },
      workspaceId: ws.id,
      teamId: team.id,
      details: { name: 'Prod', defaultRole: 'viewer' },
    });
    await call(h, admin, 'PATCH', `/workspaces/${ws.id}`, { name: 'Production', defaultRole: 'editor' });
    expect(last(events, 'workspace.renamed').details).toEqual({ name: 'Production', previousName: 'Prod' });
    expect(last(events, 'workspace.default_role_changed')).toMatchObject({
      teamId: team.id,
      details: { role: 'editor', previousRole: 'viewer' },
    });
    await call(h, admin, 'POST', `/teams/${team.id}/members`, { email: 'm@example.com', role: 'member' });
    await call(h, admin, 'PUT', `/workspaces/${ws.id}/access/${member.user.id}`, { role: 'admin' });
    expect(last(events, 'workspace.grant_set')).toMatchObject({
      target: { kind: 'user', id: member.user.id },
      workspaceId: ws.id,
      teamId: team.id,
      details: { role: 'admin' },
    });
    const before = events.length;
    await call(h, admin, 'DELETE', `/workspaces/${ws.id}/access/${member.user.id}`);
    expect(last(events, 'workspace.grant_removed').details).toEqual({ role: 'admin' });
    await call(h, admin, 'DELETE', `/workspaces/${ws.id}/access/${member.user.id}`);
    expect(events.length).toBe(before + 1); // the second delete removed nothing and recorded nothing
    await call(h, admin, 'DELETE', `/workspaces/${ws.id}`);
    expect(last(events, 'workspace.deleted')).toMatchObject({ teamId: team.id, details: { name: 'Production' } });
  });

  it('an accepted team invitation records team.member_added inside the acceptance, actor the new user', async () => {
    const team = await seedTeam(h, { name: 'Invites', admins: [admin] });
    const invited = await call<{ url: string }>(h, admin, 'POST', `/teams/${team.id}/invitations`, {
      email: 'inv@example.com',
      role: 'member',
    });
    const secret = invited.body.url.split('/').at(-1)!;
    await h.app.inject({
      method: 'POST',
      url: '/api/v1/invitations/accept',
      payload: { secret, displayName: 'Inv', password: 'correct horse battery', device: { name: 'x' } },
    });
    const added = last(events, 'team.member_added');
    expect(added.teamId).toBe(team.id);
    expect(added.details).toMatchObject({ role: 'member', via: 'invitation' });
    expect(added.actor).toMatchObject({ kind: 'user', email: 'inv@example.com' });
  });

  it('a failing audit insert fails the action and leaves neither row (spec §11)', async () => {
    h.hooks.audit.push(() => Promise.reject(new Error('audit down')));
    const res = await call(h, admin, 'POST', '/teams', { name: 'Never' });
    h.hooks.audit.pop();
    expect(res.status).toBe(500);
    expect((await h.db.query(`select 1 from teams where name = 'Never'`)).rowCount).toBe(0);
    expect(
      (await h.db.query(`select 1 from audit_events where action = 'team.created' and details->>'name' = 'Never'`))
        .rowCount,
    ).toBe(0);
  });

  it('writes no secret-shaped value', () => expectNoSecretsInAudit(h.db));
});
