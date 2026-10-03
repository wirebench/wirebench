import { afterAll, beforeAll, expect, it } from 'vitest';
import type { AuditInput } from '../../../src/context.js';
import { recordingAudit } from '../../helpers/context.js';
import { describeDb } from '../../helpers/database.js';
import { auditLogModule } from '../../../src/audit-log/module.js';
import { expectNoSecretsInAudit } from '../../helpers/context.js';
import { signedInUser } from '../../helpers/identity.js';
import { licensingHarness, testKeys } from '../../helpers/licensing.js';

const last = (events: AuditInput[], action: AuditInput['action']) => events.filter((e) => e.action === action).at(-1)!;
const PASSWORD = 'correct horse battery';

describeDb('identity fire sites (audit-log spec §3.2)', () => {
  let h: Awaited<ReturnType<typeof licensingHarness>>;
  let events: AuditInput[];
  let admin: Awaited<ReturnType<typeof signedInUser>>;

  beforeAll(async () => {
    // licensingHarness registers identity, licensing, teams, webhook capture and CI tokens, so the
    // combined migrations run 0001 to 0008 with no gap (serve.ts refuses a gap).
    h = await licensingHarness(testKeys(), { extra: (clock) => [auditLogModule({ now: () => clock.now })] });
    events = recordingAudit(h.hooks);
    admin = await signedInUser(h, { email: 'root@example.com', password: PASSWORD, serverAdmin: true });
  });
  afterAll(() => h.close());

  it('a local sign-in records user, device, token and user agent; a wrong password records anonymous with the email', async () => {
    const ok = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/local/sign-in',
      payload: { email: 'Root@example.com', password: PASSWORD, device: { name: 'laptop' } },
      headers: { 'user-agent': 'Wirebench/3.1.0 (test)' },
    });
    expect(ok.statusCode).toBe(201);
    const signedIn = last(events, 'auth.signed_in');
    expect(signedIn.actor).toMatchObject({ kind: 'user', email: 'root@example.com' });
    expect(signedIn.details).toMatchObject({ method: 'local', device: 'laptop' });
    expect(signedIn.details!['tokenId']).toBeTypeOf('string');
    expect(signedIn.userAgent).toBe('Wirebench/3.1.0 (test)');

    const bad = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/local/sign-in',
      payload: { email: 'root@example.com', password: 'nope', device: { name: 'laptop' } },
    });
    expect(bad.statusCode).toBe(401);
    const failed = last(events, 'auth.sign_in_failed');
    expect(failed.actor).toEqual({ kind: 'anonymous' });
    expect(failed.details).toMatchObject({
      method: 'local',
      reason: 'identity-invalid-credentials',
      emailLower: 'root@example.com',
    });
  });

  it('invite, revoke, re-invite, accept: the acceptance records user.created then auth.signed_in', async () => {
    const invited = await h.app.inject({
      method: 'POST',
      url: '/api/v1/invitations',
      headers: admin.headers,
      payload: { email: 'New@Example.com' },
    });
    expect(invited.statusCode).toBe(201);
    const { id } = invited.json<{ id: string }>();
    expect(last(events, 'user.invited')).toMatchObject({
      target: { kind: 'invitation', id },
      details: { emailLower: 'new@example.com', serverAdmin: false },
      actor: { kind: 'user', email: 'root@example.com' },
    });

    await h.app.inject({ method: 'DELETE', url: `/api/v1/invitations/${id}`, headers: admin.headers });
    expect(last(events, 'user.invitation_revoked')).toMatchObject({
      target: { kind: 'invitation', id },
      details: { emailLower: 'new@example.com' },
    });

    const again = await h.app.inject({
      method: 'POST',
      url: '/api/v1/invitations',
      headers: admin.headers,
      payload: { email: 'new@example.com' },
    });
    const secret = again.json<{ url: string }>().url.split('/').at(-1)!;
    const before = events.length;
    const accepted = await h.app.inject({
      method: 'POST',
      url: '/api/v1/invitations/accept',
      payload: { secret, displayName: 'New', password: PASSWORD, device: { name: 'phone' } },
    });
    expect(accepted.statusCode).toBe(201);
    expect(events.slice(before).map((e) => e.action)).toEqual(['user.created', 'auth.signed_in']);
    expect(events[before]!.details).toMatchObject({ method: 'local', emailLower: 'new@example.com' });
    expect(events[before]!.actor).toMatchObject({ kind: 'user', email: 'new@example.com' });
    expect(events[before + 1]!.details).toMatchObject({ method: 'local', device: 'phone' });
  });

  it('a rolled-back acceptance leaves no row: user.created is written before the failing accepted-hook (the real hook, not the recorder)', async () => {
    const invited = await h.app.inject({
      method: 'POST',
      url: '/api/v1/invitations',
      headers: admin.headers,
      payload: { email: 'rollback@example.com' },
    });
    const secret = invited.json<{ url: string }>().url.split('/').at(-1)!;
    h.hooks.invitationAccepted.push(() => Promise.reject(new Error('boom')));
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/invitations/accept',
      payload: { secret, displayName: 'R', password: PASSWORD, device: { name: 'x' } },
    });
    h.hooks.invitationAccepted.pop();
    expect(res.statusCode).toBe(500);
    const rows = await h.db.query(
      `select 1 from audit_events where action = 'user.created' and details->>'emailLower' = 'rollback@example.com'`,
    );
    expect(rows.rowCount).toBe(0);
  });

  it('disable, enable, admin grant and revoke record only real transitions', async () => {
    const users = await h.app.inject({ method: 'GET', url: '/api/v1/users', headers: admin.headers });
    const target = users.json<{ id: string; email: string }[]>().find((u) => u.email === 'new@example.com')!;
    const before = events.length;
    await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/users/${target.id}`,
      headers: admin.headers,
      payload: { disabled: false },
    });
    expect(events.length).toBe(before);
    await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/users/${target.id}`,
      headers: admin.headers,
      payload: { disabled: true, serverAdmin: true },
    });
    expect(
      events
        .slice(before)
        .map((e) => e.action)
        .sort(),
    ).toEqual(['user.admin_granted', 'user.disabled']);
    await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/users/${target.id}`,
      headers: admin.headers,
      payload: { disabled: false, serverAdmin: false },
    });
    expect(
      events
        .slice(-2)
        .map((e) => e.action)
        .sort(),
    ).toEqual(['user.admin_revoked', 'user.enabled']);
    for (const e of events.slice(before)) expect(e.target).toEqual({ kind: 'user', id: target.id });
  });

  it('password reset issued, password changed, sign-out and device revoke', async () => {
    const users = await h.app.inject({ method: 'GET', url: '/api/v1/users', headers: admin.headers });
    const target = users.json<{ id: string; email: string }[]>().find((u) => u.email === 'new@example.com')!;
    await h.app.inject({ method: 'POST', url: `/api/v1/users/${target.id}/password-reset`, headers: admin.headers });
    expect(last(events, 'user.password_reset_issued')).toMatchObject({ target: { kind: 'user', id: target.id } });

    const other = await signedInUser(h, { email: 'o@example.com', password: PASSWORD });
    await h.app.inject({
      method: 'POST',
      url: '/api/v1/me/password',
      headers: other.headers,
      payload: { currentPassword: PASSWORD, newPassword: 'another horse battery' },
    });
    expect(last(events, 'auth.password_changed')).toMatchObject({
      actor: { kind: 'user', email: 'o@example.com' },
      details: { via: 'self' },
    });
    await h.app.inject({ method: 'POST', url: '/api/v1/auth/sign-out', headers: other.headers });
    expect(last(events, 'auth.signed_out')).toMatchObject({
      actor: { kind: 'user', email: 'o@example.com' },
      details: { tokenId: other.tokenId },
    });
  });

  it('revoking another device records auth.signed_out with that device token', async () => {
    const laptop = await signedInUser(h, { email: 'd@example.com', password: PASSWORD, deviceName: 'laptop' });
    const phone = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/local/sign-in',
      payload: { email: 'd@example.com', password: PASSWORD, device: { name: 'phone' } },
    });
    expect(phone.statusCode).toBe(201);
    const phoneTokenId = last(events, 'auth.signed_in').details!['tokenId'] as string;
    const res = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/me/devices/${phoneTokenId}`,
      headers: laptop.headers,
    });
    expect(res.statusCode).toBe(204);
    expect(last(events, 'auth.signed_out')).toMatchObject({
      actor: { kind: 'user', email: 'd@example.com' },
      details: { tokenId: phoneTokenId },
    });
  });

  it('a failing audit insert fails the sign-in and leaves no token row', async () => {
    const user = await signedInUser(h, { email: 'f@example.com', password: PASSWORD });
    const before = await h.db.query('select 1 from device_tokens where user_id = $1', [user.user.id]);
    h.hooks.audit.push(() => Promise.reject(new Error('audit down')));
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/local/sign-in',
      payload: { email: 'f@example.com', password: PASSWORD, device: { name: 'x' } },
    });
    h.hooks.audit.pop();
    expect(res.statusCode).toBe(500);
    const after = await h.db.query('select 1 from device_tokens where user_id = $1', [user.user.id]);
    expect(after.rowCount).toBe(before.rowCount);
  });

  it('writes no secret-shaped value', () => expectNoSecretsInAudit(h.db));
});
