import { afterAll, beforeAll, expect, it } from 'vitest';
import type { AuditInput } from '../../../src/context.js';
import { auditLogModule } from '../../../src/audit-log/module.js';
import { syncModule } from '../../../src/sync/module.js';
import { recordingAudit } from '../../helpers/context.js';
import { describeDb } from '../../helpers/database.js';
import { signedInUser } from '../../helpers/identity.js';
import { licensingHarness, testKeys } from '../../helpers/licensing.js';
import { call, seedTeam } from '../../helpers/teams.js';

describeDb('the workspace feature policy (feature switches phase 4, ADR-0029)', () => {
  let h: Awaited<ReturnType<typeof licensingHarness>>;
  let events: AuditInput[];
  let admin: Awaited<ReturnType<typeof signedInUser>>;
  let editor: Awaited<ReturnType<typeof signedInUser>>;
  let teamId: string;
  let workspaceId: string;
  let otherId: string;

  beforeAll(async () => {
    h = await licensingHarness(testKeys(), {
      extra: (clock) => [auditLogModule({ now: () => clock.now }), syncModule()],
    });
    events = recordingAudit(h.hooks);
    admin = await signedInUser(h, { email: 'root@example.com', serverAdmin: true });
    editor = await signedInUser(h, { email: 'ed@example.com' });
    const team = await seedTeam(h, { name: 'Ops', admins: [admin], members: [editor] });
    teamId = team.id;
    const create = async (name: string): Promise<string> =>
      (await call<{ id: string }>(h, admin, 'POST', `/teams/${teamId}/workspaces`, { name })).body.id;
    workspaceId = await create('Prod');
    otherId = await create('Sandbox');
    await call(h, admin, 'PUT', `/workspaces/${workspaceId}/access/${editor.user.id}`, { role: 'editor' });
  });
  afterAll(() => h.close());

  const policy = async (id = workspaceId): Promise<string[]> =>
    (await call<{ disabledFeatures: string[] }>(h, admin, 'GET', `/workspaces/${id}`)).body.disabledFeatures;
  const changes = () => events.filter((e) => e.action === 'workspace.features_changed');
  const patch = (user: typeof admin, disabledFeatures: unknown) =>
    call<{ code?: string; disabledFeatures?: string[] }>(h, user, 'PATCH', `/workspaces/${workspaceId}`, {
      disabledFeatures,
    });

  it('meta lists the feature-policy capability, and a workspace never patched reads as no policy', async () => {
    const meta = await call<{ capabilities: string[] }>(h, undefined, 'GET', '/meta');
    expect(meta.body.capabilities).toContain('feature-policy');
    expect(await policy()).toEqual([]);
    const head = await call<{ disabledFeatures: string[] }>(h, editor, 'GET', `/workspaces/${workspaceId}/sync/head`);
    expect(head.body.disabledFeatures).toEqual([]);
  });

  it('an editor cannot set it', async () => {
    const res = await patch(editor, ['scripts']);
    expect(res.status).toBe(403);
    expect(await policy()).toEqual([]);
    expect(changes()).toHaveLength(0);
  });

  it('refuses an id outside the grammar and a list over 32 entries', async () => {
    for (const bad of [
      ['Scripts'],
      ['x'.repeat(33)],
      ['-scripts'],
      ['scripts', 'mcp server'],
      Array.from({ length: 33 }, (_, i) => `feature-${i}`),
    ]) {
      const res = await patch(admin, bad);
      expect(res.status, JSON.stringify(bad).slice(0, 40)).toBe(400);
    }
    expect(await policy()).toEqual([]);
    expect(changes()).toHaveLength(0);
  });

  it('a workspace admin stores the list deduplicated and sorted; it is audited and listed', async () => {
    const res = await patch(admin, ['scripts', 'mcp-server', 'scripts', 'grpc']);
    expect(res.status).toBe(200);
    expect(res.body.disabledFeatures).toEqual(['grpc', 'mcp-server', 'scripts']);
    expect(await policy()).toEqual(['grpc', 'mcp-server', 'scripts']);
    const listed = await call<{ id: string; disabledFeatures: string[] }[]>(h, editor, 'GET', '/workspaces');
    expect(listed.body.find((w) => w.id === workspaceId)?.disabledFeatures).toEqual(['grpc', 'mcp-server', 'scripts']);
    expect(changes()).toEqual([
      expect.objectContaining({
        target: { kind: 'workspace', id: workspaceId },
        workspaceId,
        teamId,
        details: { disabled: ['grpc', 'mcp-server', 'scripts'], previous: [] },
      }),
    ]);
  });

  it('the sync head carries it for every role, and the other workspace is untouched', async () => {
    const head = await call<{ disabledFeatures: string[] }>(h, editor, 'GET', `/workspaces/${workspaceId}/sync/head`);
    expect(head.status).toBe(200);
    expect(head.body.disabledFeatures).toEqual(['grpc', 'mcp-server', 'scripts']);
    expect(await policy(otherId)).toEqual([]);
  });

  it('the same list in another order or with repeats is not a change', async () => {
    const res = await patch(admin, ['scripts', 'grpc', 'mcp-server', 'grpc']);
    expect(res.status).toBe(200);
    expect(changes()).toHaveLength(1);
  });

  it('a feature this server does not know is accepted, and clearing the list is audited', async () => {
    expect((await patch(admin, ['some-future-feature'])).status).toBe(200);
    expect(await policy()).toEqual(['some-future-feature']);
    expect((await patch(admin, [])).status).toBe(200);
    expect(await policy()).toEqual([]);
    expect(changes().map((e) => e.details)).toEqual([
      { disabled: ['grpc', 'mcp-server', 'scripts'], previous: [] },
      { disabled: ['some-future-feature'], previous: ['grpc', 'mcp-server', 'scripts'] },
      { disabled: [], previous: ['some-future-feature'] },
    ]);
  });

  it('a patch that leaves the list out keeps it', async () => {
    expect((await patch(admin, ['webhooks'])).status).toBe(200);
    const res = await call(h, admin, 'PATCH', `/workspaces/${workspaceId}`, { name: 'Production' });
    expect(res.status).toBe(200);
    expect(await policy()).toEqual(['webhooks']);
  });
});
