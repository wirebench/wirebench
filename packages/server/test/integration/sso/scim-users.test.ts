import { afterEach, expect, it } from 'vitest';
import { auditLogModule } from '../../../src/audit-log/module.js';
import { SYSTEM_SOURCE, permissiveLicense, type AuditInput } from '../../../src/context.js';
import { createInvitation } from '../../../src/identity/invitations.js';
import { insertToken } from '../../../src/identity/repo.js';
import { mintToken } from '../../../src/identity/tokens.js';
import { ssoModule } from '../../../src/sso/module.js';
import { recordingAudit } from '../../helpers/context.js';
import { describeDb } from '../../helpers/database.js';
import { signedInUser, type IdentityHarness, type SignedInUser } from '../../helpers/identity.js';
import { license, licensingHarness, testKeys } from '../../helpers/licensing.js';

const PATCH_OP = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';
const USER = 'urn:ietf:params:scim:schemas:core:2.0:User';

interface ScimUser {
  id: string;
  userName: string;
  displayName: string;
  active: boolean;
  externalId?: string;
}

describeDb('SCIM users (saml-scim spec §3.5, §6.3)', () => {
  const keys = testKeys();
  let h: IdentityHarness;
  let admin: SignedInUser;
  let bearer: string;
  let tokenId: string;
  let events: AuditInput[];
  let ended: string[];

  const boot = async (seats?: number) => {
    h = await licensingHarness(keys, {
      extra: (clock) => [
        auditLogModule({ now: () => clock.now }),
        ssoModule({ now: () => clock.now, sweepIntervalMs: 0 }),
      ],
    });
    admin = await signedInUser(h, { email: 'root@example.com', serverAdmin: true });
    const put = await h.app.inject({
      method: 'PUT',
      url: '/api/v1/license',
      headers: admin.headers,
      payload: { license: license(keys, { edition: 'enterprise', ...(seats !== undefined ? { seats } : {}) }) },
    });
    expect(put.statusCode, put.body).toBe(200);
    const created = await h.app.inject({
      method: 'POST',
      url: '/api/v1/scim-tokens',
      headers: admin.headers,
      payload: { name: 'IdP' },
    });
    ({ token: bearer, id: tokenId } = created.json<{ token: string; id: string }>());
    events = recordingAudit(h.hooks);
    ended = [];
    h.hooks.sessionEnded.push((event) => {
      if ('userId' in event) ended.push(event.userId);
    });
  };
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
  const create = (userName: string, extra: object = {}) =>
    scim('POST', '/Users', { schemas: [USER], userName, ...extra });
  const patch = (id: string, Operations: object[]) =>
    scim('PATCH', `/Users/${id}`, { schemas: [PATCH_OP], Operations });
  const filter = (expression: string) => scim('GET', `/Users?filter=${encodeURIComponent(expression)}`);

  it('the Entra sequence: look up, create, rename, deactivate, reactivate, delete', async () => {
    await boot();
    expect((await filter('userName eq "ada@example.com"')).json()).toMatchObject({ totalResults: 0, Resources: [] });
    const created = await create('ada@example.com', {
      externalId: 'e-1',
      name: { givenName: 'Ada', familyName: 'Lovelace' },
      emails: [{ value: 'ada@example.com', type: 'work', primary: true }],
      active: true,
    });
    expect(created.statusCode, created.body).toBe(201);
    const ada = created.json<ScimUser>();
    expect(ada).toMatchObject({
      userName: 'ada@example.com',
      displayName: 'Ada Lovelace',
      active: true,
      externalId: 'e-1',
    });
    expect(created.headers['location']).toBe(`https://wirebench.test/scim/v2/Users/${ada.id}`);
    expect((await filter('userName eq "ADA@example.com"')).json()).toMatchObject({ totalResults: 1 });
    expect((await filter('externalId eq "e-1"')).json()).toMatchObject({ totalResults: 1 });

    const renamed = await patch(ada.id, [{ op: 'Replace', path: 'displayName', value: 'Countess Lovelace' }]);
    expect(renamed.json()).toMatchObject({ displayName: 'Countess Lovelace' });

    // A device token of hers stops working the moment she is deactivated, and her sockets are told.
    const minted = mintToken();
    await insertToken(h.db, {
      id: 'dev-ada',
      userId: ada.id,
      tokenHash: minted.hash,
      deviceName: 'Mac',
      at: h.clock.now,
    });
    const me = () =>
      h.app.inject({ method: 'GET', url: '/api/v1/me', headers: { authorization: `Bearer ${minted.token}` } });
    expect((await me()).statusCode).toBe(200);
    const off = await patch(ada.id, [{ op: 'Replace', path: 'active', value: 'False' }]);
    expect(off.json()).toMatchObject({ active: false });
    expect((await me()).statusCode).toBe(401);
    expect(ended).toEqual([ada.id]);

    expect((await patch(ada.id, [{ op: 'Replace', path: 'active', value: 'True' }])).json()).toMatchObject({
      active: true,
    });
    expect((await scim('DELETE', `/Users/${ada.id}`)).statusCode).toBe(204);
    expect((await scim('GET', `/Users/${ada.id}`)).json()).toMatchObject({ id: ada.id, active: false });

    const actions = events.map((e) => e.action);
    expect(actions).toEqual(['user.created', 'user.updated', 'user.disabled', 'user.enabled', 'user.disabled']);
    for (const event of events) expect(event.actor).toEqual({ kind: 'scim', tokenId });
    expect(events[0]!.details).toMatchObject({ method: 'scim', emailLower: 'ada@example.com' });
    expect(events[1]!.details).toEqual({ fields: ['displayName'] });
  });

  it('the Okta sequence: look up, create, replace, replace with active false', async () => {
    await boot();
    expect((await filter('userName eq "bob@example.com"')).json()).toMatchObject({ totalResults: 0 });
    const bob = (
      await create('bob@example.com', { name: { givenName: 'Bob', familyName: 'B' }, active: true })
    ).json<ScimUser>();
    const replaced = await scim('PUT', `/Users/${bob.id}`, {
      schemas: [USER],
      id: bob.id,
      userName: 'robert@example.com',
      name: { givenName: 'Robert', familyName: 'B' },
      active: true,
    });
    expect(replaced.json()).toMatchObject({ userName: 'robert@example.com', displayName: 'Robert B' });
    const off = await scim('PUT', `/Users/${bob.id}`, {
      schemas: [USER],
      userName: 'robert@example.com',
      name: { givenName: 'Robert', familyName: 'B' },
      active: false,
    });
    expect(off.json()).toMatchObject({ active: false });
    expect(events.find((e) => e.action === 'user.updated')!.details).toEqual({ fields: ['userName', 'displayName'] });
  });

  it('refuses an existing email with 409 uniqueness, on create and on rename', async () => {
    await boot();
    const taken = await create('ROOT@example.com');
    expect(taken.statusCode).toBe(409);
    expect(taken.json()).toMatchObject({ status: '409', scimType: 'uniqueness' });
    const carol = (await create('carol@example.com')).json<ScimUser>();
    const rename = await patch(carol.id, [{ op: 'replace', path: 'userName', value: 'root@example.com' }]);
    expect(rename.json()).toMatchObject({ scimType: 'uniqueness' });
  });

  it('accepts an open invitation for the email, so its team invitation applies', async () => {
    await boot();
    const accepted: unknown[] = [];
    h.hooks.invitationAccepted.push((_tx, event) => {
      accepted.push(event);
      return Promise.resolve();
    });
    const invitation = await createInvitation(
      {
        ctx: {
          db: h.db,
          config: { publicUrl: 'https://wirebench.test' },
          hooks: h.hooks,
          license: permissiveLicense(),
        },
        settings: { invitationMs: 7 * 86_400_000 },
        now: () => h.clock.now,
      } as never,
      { email: 'dan@example.com', serverAdmin: false, createdBy: null, source: SYSTEM_SOURCE },
    );
    const dan = (await create('dan@example.com')).json<ScimUser>();
    expect(accepted).toEqual([{ invitationId: invitation.id, userId: dan.id }]);
  });

  it('takes a seat for an active user, none for an inactive one, and checks one on reactivation', async () => {
    await boot(2); // root plus one
    const eve = (await create('eve@example.com', { active: false })).json<ScimUser>();
    expect(eve.active).toBe(false);
    expect((await create('fay@example.com')).statusCode).toBe(201);
    const full = await create('gus@example.com');
    expect(full.statusCode).toBe(403);
    expect(full.json()).toMatchObject({ status: '403' });
    const back = await patch(eve.id, [{ op: 'replace', value: { active: true } }]);
    expect(back.statusCode).toBe(403);
  });

  it('never deactivates the last enabled server admin', async () => {
    await boot();
    const res = await patch(admin.user.id, [{ op: 'replace', path: 'active', value: false }]);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ scimType: 'mutability' });
    expect((await scim('DELETE', `/Users/${admin.user.id}`)).statusCode).toBe(409);
  });

  it('pages with startIndex and count', async () => {
    await boot();
    for (const name of ['a', 'b', 'c']) await create(`${name}@example.com`);
    const page = (await scim('GET', '/Users?startIndex=2&count=2')).json<{
      totalResults: number;
      startIndex: number;
      itemsPerPage: number;
      Resources: ScimUser[];
    }>();
    expect(page).toMatchObject({ totalResults: 4, startIndex: 2, itemsPerPage: 2 });
    expect(page.Resources.map((u) => u.userName)).toEqual(['a@example.com', 'b@example.com']);
  });

  it('answers SCIM errors for a bad filter, an unknown user and a bad PATCH', async () => {
    await boot();
    expect((await filter('userName co "a"')).json()).toMatchObject({ status: '400', scimType: 'invalidFilter' });
    expect((await scim('GET', '/Users/nope')).statusCode).toBe(404);
    const zed = (await create('zed@example.com')).json<ScimUser>();
    expect((await patch(zed.id, [{ op: 'replace', path: 'shoeSize', value: '9' }])).json()).toMatchObject({
      scimType: 'invalidPath',
    });
    expect((await create('not-an-email')).json()).toMatchObject({ scimType: 'invalidValue' });
  });
});
