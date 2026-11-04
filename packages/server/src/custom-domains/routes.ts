/**
 * `/api/v1/tenant/domain` (hosted edition spec §23.6): the tenant's one custom name. Server admins only, behind the
 * `custom-domains` feature, in hosted mode only: a self-hosted server answers `404 custom-domains-hosted-only` on all
 * four, since it chooses its own public URL.
 *
 * Every answer is the request's own tenant's claim, read in its unit under row-level security, so no route can show
 * another tenant's claim, token or state. A name another tenant holds reads `heldElsewhere`, never by whom.
 */
import {
  customDomainClaimRequestSchema,
  customDomainResponseSchema,
  type CustomDomain,
  type CustomDomainClaimRequest,
  type CustomDomainResponse,
} from '@wirebench/engine';
import type { FastifyInstance, preHandlerAsyncHookHandler } from 'fastify';
import type { ModuleConfig } from '../config.js';
import { auditSource, recordAudit, type AuditSource, type LicenseService, type ServerHooks } from '../context.js';
import { requireServerAdmin } from '../identity/guard.js';
import { rateLimit, type TenantRateLimiter } from '../identity/rate-limit.js';
import { problem } from '../problem.js';
import { jsonSchema } from '../schema.js';
import type { TenantScope } from '../tenancy/scope.js';
import type { Tenancy } from '../tenancy/tenancy.js';
import type { TenantQuerier } from '../tenancy/tenant-db.js';
import { checkTenant, CUSTOM_DOMAINS_FEATURE, type CheckDeps } from './job.js';
import { checkCustomName, recordsFor, type CustomNameReason } from './names.js';
import { claim, getClaim, removeClaim, type Claim, type RemovedClaim } from './repo.js';

export const DOMAIN_ROUTE = '/tenant/domain';

const REASONS: Record<CustomNameReason, string> = {
  'custom-name-invalid':
    'Enter a domain name such as wirebench.example.com: at least two labels, with no scheme, port, path or wildcard.',
  'custom-name-ours': "That name belongs to this service. Enter a name under your organization's own domain.",
  'custom-name-local': 'That name cannot be reached from the internet. Enter a public domain name.',
};

/** The routes' answer in self-hosted mode (spec §23.1). */
export const hostedOnly = () =>
  problem(
    'custom-domains-hosted-only',
    'Custom domains are a hosted feature: a self-hosted server sets its own public URL.',
    404,
  );

/** `POST …/check`'s refusal within a minute of the last (spec §23.2). Sent with `retry-after`. */
export const CHECK_RATE_LIMITED = {
  code: 'custom-domains-check-rate-limited',
  message: 'This name was checked less than a minute ago. Try again shortly.',
} as const;

/** The claim as the routes answer it: the two records, with the token only in the TXT record's value. */
export function claimWire(found: Claim, appDomain: string): CustomDomain {
  const last = found.lastResult;
  return {
    name: found.name,
    state: found.state,
    records: recordsFor(found.name, found.token, appDomain).map((record) => ({ ...record })),
    lastResult:
      last === null
        ? null
        : {
            cname: last.cname,
            txt: last.txt,
            ...(last.certificate !== undefined ? { certificate: last.certificate } : {}),
            ...(last.heldElsewhere === true ? { heldElsewhere: true as const } : {}),
            message: last.message,
          },
    checkedAt: found.checkedAt === null ? null : found.checkedAt.toISOString(),
  };
}

export interface DomainRoutesEnv {
  readonly config: Pick<ModuleConfig, 'mode' | 'appDomain' | 'siteDomain'>;
  readonly tenancy: Pick<Tenancy, 'db'>;
  readonly hooks: ServerHooks;
  /** Read at request time: the licensing module replaces `ctx.license` when it registers. */
  readonly license: () => LicenseService;
  /** Hosted mode only; the check's dependencies. */
  readonly check?: CheckDeps;
  /** Once a minute per tenant (spec §23.2). */
  readonly limiter: TenantRateLimiter;
  readonly now: () => Date;
  /** Tests only: names under `.test` may be claimed. */
  readonly allowTestNames?: boolean;
}

/** The claim's removal in `tx`, with its audit event: the route and `admin domains remove` share it. */
export async function removeAudited(
  hooks: ServerHooks,
  tx: TenantQuerier,
  source: AuditSource,
): Promise<RemovedClaim | undefined> {
  const removed = await removeClaim(tx);
  if (removed !== undefined) {
    await recordAudit(hooks, tx, {
      ...source,
      action: 'custom_domain.removed',
      target: { kind: 'custom-domain' },
      details: { name: removed.name, state: removed.state },
    });
  }
  return removed;
}

export const domainRoutes =
  (env: DomainRoutesEnv) =>
  (app: FastifyInstance): void => {
    const hosted = env.config.mode === 'hosted';
    const refuseSelfHosted: preHandlerAsyncHookHandler = () => Promise.reject(hostedOnly());
    const feature: preHandlerAsyncHookHandler = (request, reply) =>
      env.license().requireFeature(CUSTOM_DOMAINS_FEATURE).call(app, request, reply);
    // Self-hosted: the one answer, before anything else is asked of the caller.
    const preHandler = hosted ? [requireServerAdmin, feature] : [refuseSelfHosted];
    const response = { 200: jsonSchema(customDomainResponseSchema) };
    const appDomain = env.config.appDomain ?? '';
    const answer = (found: Claim | undefined): CustomDomainResponse =>
      found === undefined ? {} : claimWire(found, appDomain);
    const read = (scope: TenantScope) => env.tenancy.db(scope).transaction((tx) => getClaim(tx));

    app.get(DOMAIN_ROUTE, { preHandler, schema: { response } }, async (request) => answer(await read(request.tenant)));

    app.put(
      DOMAIN_ROUTE,
      { preHandler, schema: { body: jsonSchema(customDomainClaimRequestSchema, { io: 'input' }), response } },
      async (request) => {
        const { name: input } = request.body as CustomDomainClaimRequest;
        const checked = checkCustomName(input, {
          appDomain,
          siteDomain: env.config.siteDomain ?? '',
          ...(env.allowTestNames === true ? { allowTest: true } : {}),
        });
        if (!checked.ok) throw problem(checked.reason, REASONS[checked.reason], 400);
        const source = auditSource(request);
        // A new claim is pending and holds nothing in `tenant_hosts`, so the resolver's map has nothing to hear.
        const made = await env.tenancy.db(request.tenant).transaction(async (tx) => {
          const row = await claim(tx, { name: checked.name, createdBy: request.caller!.id, now: env.now() });
          await recordAudit(env.hooks, tx, {
            ...source,
            action: 'custom_domain.claimed',
            target: { kind: 'custom-domain' },
            details: { name: row.name },
          });
          return row;
        });
        return answer(made);
      },
    );

    const checkNow = hosted
      ? [...preHandler, rateLimit(env, (request) => [`${request.tenant.tenantId}:check`], CHECK_RATE_LIMITED)]
      : preHandler;
    app.post(`${DOMAIN_ROUTE}/check`, { preHandler: checkNow, schema: { response } }, async (request) =>
      answer(await checkTenant(env.check!, request.tenant)),
    );

    app.delete(DOMAIN_ROUTE, { preHandler }, async (request, reply) => {
      const source = auditSource(request);
      const removed = await env.tenancy.db(request.tenant).transaction((tx) => removeAudited(env.hooks, tx, source));
      // Only a released `tenant_hosts` row can change what the resolver maps.
      if (removed?.released === true) env.check?.hostsChanged?.();
      return reply.code(204).send();
    });
  };
