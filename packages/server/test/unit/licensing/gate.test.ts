// packages/server/test/unit/licensing/gate.test.ts
import Fastify from 'fastify';
import type { LicenseState } from '@wirebench/engine';
import { describe, expect, it } from 'vitest';
import { permissiveLicense } from '../../../src/context.js';
import { requireFeature } from '../../../src/licensing/gate.js';
import { toProblem } from '../../../src/problem.js';

const community: LicenseState = { edition: 'community', status: 'none', seats: { used: 1, limit: 5 }, features: [] };

async function probe(state: () => Promise<LicenseState>) {
  const app = Fastify();
  app.setErrorHandler((error, _request, reply) => {
    const mapped = toProblem(error);
    return reply.code(mapped.status).send(mapped.body);
  });
  app.get('/probe', { preHandler: requireFeature('audit-log', state) }, () => ({ ok: true }));
  const res = await app.inject({ method: 'GET', url: '/probe' });
  await app.close();
  return res;
}

describe('requireFeature (licensing spec §3.5)', () => {
  it('refuses with 403 licensing-feature-required, naming the feature, when it is not granted', async () => {
    const res = await probe(() => Promise.resolve(community));
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'licensing-feature-required' });
    expect(res.json<{ message: string }>().message).toContain('audit-log');
  });

  it('passes when the state grants it', async () => {
    const res = await probe(() => Promise.resolve({ ...community, edition: 'enterprise', features: ['audit-log'] }));
    expect(res.statusCode).toBe(200);
  });

  it('reads the state on every request, so a new license applies with no restart', async () => {
    let features: LicenseState['features'] = [];
    const app = Fastify();
    app.setErrorHandler((error, _request, reply) => {
      const mapped = toProblem(error);
      return reply.code(mapped.status).send(mapped.body);
    });
    app.get(
      '/probe',
      { preHandler: requireFeature('audit-log', () => Promise.resolve({ ...community, features })) },
      () => ({}),
    );
    expect((await app.inject({ method: 'GET', url: '/probe' })).statusCode).toBe(403);
    features = ['audit-log'];
    expect((await app.inject({ method: 'GET', url: '/probe' })).statusCode).toBe(200);
    await app.close();
  });

  it('the permissive default grants no feature and never refuses a seat', async () => {
    const license = permissiveLicense();
    await expect(license.assertSeatAvailable({} as never)).resolves.toBeUndefined();
    const res = await probe(() => license.state());
    expect(res.statusCode).toBe(403);
  });
});
