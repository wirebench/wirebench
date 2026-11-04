import { access, constants } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import type { ServerContext } from '../context.js';

export type CheckResult = 'ok' | 'failed';

/** Each check answers pass/fail only: the endpoint is reachable by anyone who can reach the port. */
export async function runChecks(ctx: ServerContext): Promise<Record<'database' | 'dataDir' | 'git', CheckResult>> {
  const [database, dataDir, git] = await Promise.all([
    ctx.tenancy.reachable().then(
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
    // Spec §20.9: what a balancer's health check reads, so a process starting, draining or without its bus gets no
    // new socket. It reads no tenant and nothing but this process's own state.
    app.get('/readyz', async (_request, reply) => {
      const status = ctx.instance.readiness();
      return reply.code(status === 'ready' ? 200 : 503).send({ status });
    });
  };
}
