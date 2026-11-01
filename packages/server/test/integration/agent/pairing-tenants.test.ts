/**
 * The failed-pairing budget through the route (Task 15 review M1): on a hosted server, 50 failed pairings on one
 * tenant's host close pairing there and leave another tenant's budget whole (hosted edition spec §19.8 guard 5).
 */
import { generateKeyPairSync } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { agentModule } from '../../../src/agent/module.js';
import type { ServerConfig } from '../../../src/config.js';
import { TenantAdmin } from '../../../src/tenancy/directory.js';
import { directoryOf } from '../../../src/tenancy/tenancy.js';
import { describeDb } from '../../helpers/database.js';
import { identityHarness, type IdentityHarness } from '../../helpers/identity.js';

const ENV = {
  WIREBENCH_SERVER_BROWSER_CLIENT: 'true',
  WIREBENCH_SERVER_SECRETS_KEY: Buffer.alloc(32, 7).toString('base64'),
};
const hosted = (config: ServerConfig): ServerConfig => ({ ...config, mode: 'hosted', appDomain: 'example.test' });
const PUBLIC_KEY = generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).toString('base64');

describeDb('the failed-pairing budget per tenant, through the route', () => {
  let h: IdentityHarness;
  beforeAll(async () => {
    h = await identityHarness({
      env: ENV,
      configure: hosted,
      modules: (clock) => [agentModule({ now: () => clock.now, sweepIntervalMs: 0 })],
      beforeBuild: async (db, ctx) => {
        for (const slug of ['acme', 'globex']) {
          await new TenantAdmin(db, directoryOf(ctx.tenancy)).create({ slug, name: slug });
        }
      },
    });
  });
  afterAll(() => h.close());

  /** A well-formed code nobody holds, from an address of its own each five tries (the per-address limit is 20). */
  const pair = (host: string, i: number) =>
    h.app.inject({
      method: 'POST',
      url: '/api/v1/agent/pairings',
      remoteAddress: `203.0.113.${String(Math.floor(i / 5) + 1)}`,
      headers: { host },
      payload: { code: 'AAAAAA', agentId: 'agent-1', publicKey: PUBLIC_KEY, port: 47615, sshOptIn: false },
    });

  it('50 failures on acme’s host close pairing on acme only', async () => {
    for (let i = 0; i < 50; i++) {
      const res = await pair('acme.example.test', i);
      expect(res.json<{ code: string }>().code, String(i)).toBe('agent-pairing-code-invalid');
    }
    expect((await pair('acme.example.test', 50)).statusCode).toBe(429);
    const other = await pair('globex.example.test', 0);
    expect(other.statusCode).not.toBe(429);
    expect(other.json<{ code: string }>().code).toBe('agent-pairing-code-invalid');
  });
});
