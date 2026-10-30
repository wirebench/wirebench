import { afterEach, beforeEach, expect, it } from 'vitest';
import { SYSTEM_SOURCE, permissiveLicense, type AuditInput } from '../../../src/context.js';
import * as repo from '../../../src/identity/repo.js';
import { setUserDisabled } from '../../../src/identity/user-state.js';
import { recordingAudit } from '../../helpers/context.js';
import { describeDb } from '../../helpers/database.js';
import { identityHarness, signedInUser, type IdentityHarness } from '../../helpers/identity.js';

describeDb('setUserDisabled (saml-scim plan ruling 4)', () => {
  let h: IdentityHarness;
  let events: AuditInput[];
  beforeEach(async () => {
    h = await identityHarness();
    events = recordingAudit(h.hooks);
  });
  afterEach(async () => {
    await h.close();
  });

  const env = () => ({ ctx: { hooks: h.hooks, license: permissiveLicense() }, now: () => h.clock.now }) as never;
  const set = (userId: string, disabled: boolean) =>
    h.tdb.transaction((tx) => setUserDisabled(env(), tx, userId, disabled, SYSTEM_SOURCE));

  it('disables, revokes every token and records user.disabled; enabling records user.enabled', async () => {
    const ada = await signedInUser(h, { email: 'ada@example.com' });
    expect(await set(ada.user.id, true)).toBe(true);
    expect((await repo.findUserById(h.tdb, ada.user.id))?.disabledAt).not.toBeNull();
    const me = await h.app.inject({ method: 'GET', url: '/api/v1/me', headers: ada.headers });
    expect(me.statusCode).toBe(401);
    expect(await set(ada.user.id, false)).toBe(true);
    expect((await repo.findUserById(h.tdb, ada.user.id))?.disabledAt).toBeNull();
    expect(events.map((e) => e.action)).toEqual(['user.disabled', 'user.enabled']);
  });

  it('a no-op transition changes nothing and records nothing', async () => {
    const ada = await signedInUser(h, { email: 'ada@example.com' });
    expect(await set(ada.user.id, false)).toBe(false);
    const dis = await signedInUser(h, { email: 'dis@example.com', disabled: true });
    expect(await set(dis.user.id, true)).toBe(false);
    expect(await set('no-such-user', true)).toBe(false);
    expect(events).toEqual([]);
  });
});
