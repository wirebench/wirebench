/**
 * Live updates with two tenants on one server (tenancy plan Task 11; spec §19.8 guard 5). A real socket of the
 * default tenant subscribes to a workspace; announcements naming a second tenant, with the very same ids, never
 * reach it, and its own tenant's do. The socket's statements all run in its tenant's units.
 */
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { LiveServerMessage } from '@wirebench/engine';
import { TenantAdmin } from '../../../src/tenancy/directory.js';
import type { TenantScope } from '../../../src/tenancy/scope.js';
import { directoryOf } from '../../../src/tenancy/tenancy.js';
import { describeDb } from '../../helpers/database.js';
import { signedInUser, type SignedInUser } from '../../helpers/identity.js';
import { liveHarness, openLive, type LiveHarness, type LiveTestClient } from '../../helpers/live.js';
import { seedSyncWorkspace } from '../../helpers/sync.js';
import { seedTeam } from '../../helpers/teams.js';
import { expectAllScoped } from '../../helpers/tenancy.js';

const HOOK = '01J8ZC5Q0V7R3T9XK2M4N6H001';
const CAPTURE = '01J8ZE00000000000000000001';

describeDb('live updates with two tenants on one server (tenancy Task 11)', () => {
  let h: LiveHarness;
  let ana: SignedInUser;
  let workspaceId: string;
  let other: TenantScope;
  let client: LiveTestClient;
  beforeEach(async () => {
    h = await liveHarness();
    ana = await signedInUser(h, { email: 'ana@example.com' });
    const team = await seedTeam(h, { name: 'Payments QA', admins: [ana] });
    workspaceId = await seedSyncWorkspace(h, { team, name: 'Staging' });
    other = (await new TenantAdmin(h.db, directoryOf(h.ctx.tenancy)).create({ slug: 'second', name: 'Second' })).scope;
    h.statements.entries.length = 0;
    client = await openLive(h, ana.token);
    await client.next('ready');
    client.send({ type: 'subscribe', workspaceId });
    await client.next('presence');
  });
  afterEach(async () => {
    client.close();
    await h.close();
  });

  const typesOf = (messages: readonly LiveServerMessage[]) => messages.map((message) => message.type);

  it("never delivers another tenant's head, capture, hooks or ending, though every id matches", async () => {
    const as = (tenant: TenantScope) => ({ tenantId: tenant.tenantId });
    const announceAll = (tenant: TenantScope) => {
      for (const listener of h.hooks.headMoved)
        listener({ ...as(tenant), workspaceId, head: 'b'.repeat(40), tokenId: 'someone-else' });
      for (const listener of h.hooks.captureReceived)
        listener({ ...as(tenant), workspaceId, hookId: HOOK, captureId: CAPTURE });
      for (const listener of h.hooks.hooksChanged) listener({ ...as(tenant), workspaceId });
    };
    announceAll(other);
    for (const listener of h.hooks.sessionEnded) listener({ ...as(other), tokenId: ana.tokenId });
    for (const listener of h.hooks.sessionEnded) listener({ ...as(other), userId: ana.user.id });
    // Its own tenant's arrive, in order: the other tenant's would have come first.
    const own = h.tdb.scope;
    announceAll(own);
    await client.next('hooks');
    expect(typesOf(client.messages)).toEqual(['ready', 'presence', 'head', 'capture', 'hooks']);
    for (const listener of h.hooks.sessionEnded) listener({ ...as(own), tokenId: ana.tokenId });
    expect(await client.closed).toEqual({ code: 4401 });
  });

  it("authenticates and checks the subscription in the socket's tenant", () => {
    expectAllScoped(h.statements, h.tdb.scope.tenantId);
  });
});
