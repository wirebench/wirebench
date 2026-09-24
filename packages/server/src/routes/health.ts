import { access, constants } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import type { ServerContext } from '../context.js';

export type CheckResult = 'ok' | 'failed';

/** Each check answers pass/fail only: the endpoint is reachable by anyone who can reach the port. */
export async function runChecks(ctx: ServerContext): Promise<Record<'database' | 'dataDir' | 'git', CheckResult>> {
  const [database, dataDir, git] = await Promise.all([
    ctx.db.query('select 1').then(
      () => 'ok' as const,
      () => 'failed' as const,
    ),
    access(ctx.config.dataDir, constants.W_OK).then(
      () => 'ok' as const,
      () => 'failed' as const,
    ),
    Promise.resolve(ctx.git.version === '' ? ('failed' as const) : ('ok' as const)),
  ]);
  return { database, dataDir, git };
}

export function healthRoutes(ctx: ServerContext) {
  return (app: FastifyInstance): void => {
    app.get('/healthz', async (_request, reply) => {
      const checks = await runChecks(ctx);
      const ok = Object.values(checks).every((value) => value === 'ok');
      return reply.code(ok ? 200 : 503).send({ status: ok ? 'ok' : 'failed', checks });
    });
  };
}
