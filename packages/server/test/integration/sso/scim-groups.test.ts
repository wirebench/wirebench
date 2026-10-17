import { afterEach, beforeEach, expect, it } from 'vitest';
import { auditLogModule } from '../../../src/audit-log/module.js';
import type { AuditInput } from '../../../src/context.js';
import { ssoModule } from '../../../src/sso/module.js';
import { recordingAudit } from '../../helpers/context.js';
import { describeDb } from '../../helpers/database.js';
import { signedInUser, type IdentityHarness, type SignedInUser } from '../../helpers/identity.js';
import { license, licenseInstallRecorded, licensingHarness, testKeys } from '../../helpers/licensing.js';

const PATCH_OP = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';
const GROUP = 'urn:ietf:params:scim:schemas:core:2.0:Group';

interface ScimGroup {
  id: string;
  displayName: string;
  externalId?: string;
  members?: { value: string; display: string }[];
}

describeDb('SCIM groups (saml-scim spec §3.5)', () => {
  const keys = testKeys();
  let h: IdentityHarness;
  let admin: SignedInUser;
  let bearer: string;
  let events: AuditInput[];
  let ada: string;
  let bob: string;
  let cy: string;

  beforeEach(async () => {
    h = await licensingHarness(keys, {
      extra: (clock) => [
        auditLogModule({ now: () => clock.now }),
        ssoModule({ now: () => clock.now, sweepIntervalMs: 0 }),
      ],
    });
    admin = await signedInUser(h, { email: 'root@example.com', serverAdmin: true });
    await h.app.inject({
      method: 'PUT',
      url: '/api/v1/license',
      headers: admin.headers,
      payload: { license: license(keys, { edition: 'enterprise' }) },
    });
    await licenseInstallRecorded(h);
    bearer = (
      await h.app.inject({
        method: 'POST',
        url: '/api/v1/scim-tokens',
        headers: admin.headers,
        payload: { name: 'IdP' },
      })
    ).json<{ token: string }>().token;
    ada = (await signedInUser(h, { email: 'ada@example.com' })).user.id;
    bob = (await signedInUser(h, { email: 'bob@example.com' })).user.id;
    cy = (await signedInUser(h, { email: 'cy@example.com' })).user.id;
    events = recordingAudit(h.hooks);
  });
  afterEach(async () => {
    await h.close();
  });

  const scim = (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, payload?: object) =>
    h.app.inject({
      method,
      url: `/scim/v2${path}`,
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/scim+json' },
      ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}),
    });
  const create = (displayName: string, members: string[] = [], extra: object = {}) =>
    scim('POST', '/Groups', { schemas: [GROUP], displayName, members: members.map((value) => ({ value })), ...extra });
  const patch = (id: string, Operations: object[]) =>
    scim('PATCH', `/Groups/${id}`, { schemas: [PATCH_OP], Operations });
  const memberIds = async (id: string) =>
    ((await scim('GET', `/Groups/${id}`)).json<ScimGroup>().members ?? []).map((m) => m.value).sort();

  it('creates a group with members, and reads it back with and without members', async () => {
    const created = await create('Engineering', [ada, bob], { externalId: 'g-1' });
    expect(created.statusCode, created.body).toBe(201);
    const group = created.json<ScimGroup>();
    expect(group).toMatchObject({ displayName: 'Engineering', externalId: 'g-1' });
    expect(group.members!.map((m) => m.display).sort()).toEqual(['ada@example.com', 'bob@example.com']);
    const found = await scim(
      'GET',
      `/Groups?filter=${encodeURIComponent('displayName eq "engineering"')}&excludedAttributes=members`,
    );
    expect(found.json()).toMatchObject({ totalResults: 1, Resources: [{ id: group.id }] });
    expect(found.json<{ Resources: ScimGroup[] }>().Resources[0]).not.toHaveProperty('members');
    expect((await scim('GET', `/Groups?filter=${encodeURIComponent('externalId eq "g-1"')}`)).json()).toMatchObject({
      totalResults: 1,
    });
  });

  it('refuses an unknown member and a duplicate displayName', async () => {
    const unknown = await create('Ghosts', ['no-such-user']);
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json()).toMatchObject({ scimType: 'invalidValue' });
    await create('Engineering');
    const dup = await create('ENGINEERING');
    expect(dup.statusCode).toBe(409);
    expect(dup.json()).toMatchObject({ scimType: 'uniqueness' });
  });

  it('PATCH adds, removes by filter (Entra), removes by value list (Okta) and renames', async () => {
    const { id } = (await create('Engineering', [ada])).json<ScimGroup>();
    await patch(id, [{ op: 'Add', path: 'members', value: [{ value: bob }, { value: cy }] }]);
    expect(await memberIds(id)).toEqual([ada, bob, cy].sort());
    await patch(id, [{ op: 'Remove', path: `members[value eq "${ada}"]` }]);
    expect(await memberIds(id)).toEqual([bob, cy].sort());
    await patch(id, [{ op: 'remove', path: 'members', value: [{ value: bob }] }]);
    expect(await memberIds(id)).toEqual([cy]);
    const renamed = await patch(id, [{ op: 'replace', path: 'displayName', value: 'Platform' }]);
    expect(renamed.json()).toMatchObject({ displayName: 'Platform' });
    const unknown = await patch(id, [{ op: 'add', path: 'members', value: [{ value: 'ghost' }] }]);
    expect(unknown.json()).toMatchObject({ scimType: 'invalidValue' });
  });

  it('PUT replaces the members; DELETE removes the group', async () => {
    const { id } = (await create('Engineering', [ada, bob])).json<ScimGroup>();
    const put = await scim('PUT', `/Groups/${id}`, {
      schemas: [GROUP],
      displayName: 'Engineering',
      members: [{ value: cy }],
    });
    expect(put.statusCode, put.body).toBe(200);
    expect(await memberIds(id)).toEqual([cy]);
    expect((await scim('DELETE', `/Groups/${id}`)).statusCode).toBe(204);
    expect((await scim('GET', `/Groups/${id}`)).statusCode).toBe(404);
  });

  it('records scim.group_created, scim.group_updated and scim.group_deleted as the SCIM token', async () => {
    const { id } = (await create('Engineering', [ada])).json<ScimGroup>();
    await patch(id, [{ op: 'Add', path: 'members', value: [{ value: bob }] }]);
    await patch(id, [{ op: 'Add', path: 'members', value: [{ value: bob }] }]); // no change, no event
    await scim('DELETE', `/Groups/${id}`);
    expect(events.map((e) => e.action)).toEqual(['scim.group_created', 'scim.group_updated', 'scim.group_deleted']);
    expect(events[1]!.details).toEqual({ displayName: 'Engineering', fields: [], membersAdded: 1, membersRemoved: 0 });
    for (const event of events) expect(event.actor.kind).toBe('scim');
  });
});
