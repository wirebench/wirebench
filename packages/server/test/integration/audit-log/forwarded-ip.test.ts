import { afterAll, beforeAll, expect, it } from 'vitest';
import { auditLogModule } from '../../../src/audit-log/module.js';
import { describeDb } from '../../helpers/database.js';
import { signedInUser } from '../../helpers/identity.js';
import { licensingHarness, testKeys } from '../../helpers/licensing.js';

const PASSWORD = 'correct horse battery';

/** Behind a trusted proxy `request.ip` is whatever the client sent; a junk value must not fail the action. */
describeDb('audit ip behind a trusted proxy', () => {
  let h: Awaited<ReturnType<typeof licensingHarness>>;
  let admin: Awaited<ReturnType<typeof signedInUser>>;

  beforeAll(async () => {
    h = await licensingHarness(testKeys(), {
      env: { WIREBENCH_SERVER_TRUST_PROXY: 'true' },
      extra: (clock) => [auditLogModule({ now: () => clock.now })],
    });
    admin = await signedInUser(h, { email: 'root@example.com', password: PASSWORD, serverAdmin: true });
  });
  afterAll(() => h.close());

  const ipOf = async (action: string, emailLower: string) => {
    const rows = await h.db.query<{ ip: string | null }>(
      `select host(ip) as ip from audit_events where action = $1 and details->>'emailLower' = $2`,
      [action, emailLower],
    );
    expect(rows.rowCount).toBe(1);
    return rows.rows[0]!.ip;
  };

  it('a wrong password with a junk X-Forwarded-For still answers 401 and records the failure with no ip', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/local/sign-in',
      headers: { 'x-forwarded-for': 'x' },
      payload: { email: 'root@example.com', password: 'nope', device: { name: 'laptop' } },
    });
    expect(res.statusCode).toBe(401);
    expect(await ipOf('auth.sign_in_failed', 'root@example.com')).toBeNull();
  });

  const invite = (email: string, forwardedFor: string) =>
    h.app.inject({
      method: 'POST',
      url: '/api/v1/invitations',
      headers: { ...admin.headers, 'x-forwarded-for': forwardedFor },
      payload: { email },
    });

  it('an audited action with a junk X-Forwarded-For succeeds and records no ip', async () => {
    expect((await invite('garbage@example.com', 'garbage')).statusCode).toBe(201);
    expect(await ipOf('user.invited', 'garbage@example.com')).toBeNull();
  });

  it('an IPv4 port and an IPv6 zone are dropped, the address kept', async () => {
    expect((await invite('port@example.com', '1.2.3.4:5678')).statusCode).toBe(201);
    expect(await ipOf('user.invited', 'port@example.com')).toBe('1.2.3.4');
    expect((await invite('zone@example.com', 'fe80::1%eth0')).statusCode).toBe(201);
    expect(await ipOf('user.invited', 'zone@example.com')).toBe('fe80::1');
  });
});
