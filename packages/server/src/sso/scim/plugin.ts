/**
 * The SCIM 2.0 scope at `/scim/v2` (saml-scim spec §3.5, §6.2). It sits beside `/api/v1`, not inside it, so
 * identity's device-token guard never runs here and a SCIM token never reaches `/api/v1`. Everything in
 * this scope (the media type parser, the error handler, the bearer check) is registered on the scope
 * alone (plan rulings 5 and 7).
 */
import { timingSafeEqual } from 'node:crypto';
import { SCIM_TOKEN_PATTERN } from '@wirebench/engine';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ANONYMOUS_SOURCE, auditSource, recordAudit, type AuditSource } from '../../context.js';
import { hashSecret } from '../../identity/tokens.js';
import type { SsoEnv } from '../env.js';
import * as repo from '../repo.js';
import { discoveryRoutes } from './discovery.js';
import { scimError, toScimError } from './errors.js';

export const SCIM_MEDIA_TYPE = 'application/scim+json';
/** Far above any real SCIM body; a group with thousands of members fits. */
const SCIM_BODY_LIMIT = 1024 * 1024;
const MINUTE_MS = 60_000;

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the SCIM scope's bearer check: the token this request authenticated with. */
    scimToken?: { readonly id: string };
  }
}

/** The audit actor for a SCIM write (§3.5). */
export function scimSource(request: FastifyRequest): AuditSource {
  const base = auditSource(request);
  return { ...base, actor: { kind: 'scim', tokenId: request.scimToken!.id } };
}

function bearerOf(header: string | undefined): string | undefined {
  const match = /^Bearer\s+(\S+)$/i.exec(header?.trim() ?? '');
  const token = match?.[1];
  return token !== undefined && SCIM_TOKEN_PATTERN.test(token) ? token : undefined;
}

function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === y.length && timingSafeEqual(x, y);
}

export const scimPlugin =
  (env: SsoEnv) =>
  async (scim: FastifyInstance): Promise<void> => {
    /** IP → when a failed attempt was last audited: at most one row a minute per address (§6.2). */
    const auditedAt = new Map<string, number>();

    const parseJson = (
      _request: FastifyRequest,
      body: string | Buffer,
      done: (e: Error | null, v?: unknown) => void,
    ) => {
      try {
        done(null, body.length === 0 ? undefined : JSON.parse(body.toString()));
      } catch {
        done(scimError(400, 'The request body is not valid JSON.', 'invalidSyntax'));
      }
    };
    scim.removeAllContentTypeParsers();
    scim.addContentTypeParser(
      [SCIM_MEDIA_TYPE, 'application/json'],
      { parseAs: 'string', bodyLimit: SCIM_BODY_LIMIT },
      parseJson,
    );

    scim.setErrorHandler((error, request, reply) => {
      const scimErr = toScimError(error);
      if (scimErr.status >= 500) request.log.error({ err: error }, 'scim request failed');
      return reply.code(scimErr.status).type(SCIM_MEDIA_TYPE).send(scimErr.body());
    });
    scim.setNotFoundHandler((_request, reply) =>
      reply.code(404).type(SCIM_MEDIA_TYPE).send(scimError(404, 'No such SCIM endpoint.').body()),
    );

    const refuse = async (request: FastifyRequest, reply: FastifyReply, reason: string): Promise<FastifyReply> => {
      const decision = env.limiter.take(`scim:ip:${request.ip}`);
      if (!decision.allowed) {
        return reply
          .code(429)
          .header('retry-after', String(decision.retryAfterSeconds))
          .type(SCIM_MEDIA_TYPE)
          .send(scimError(429, 'Too many failed attempts. Try again shortly.').body());
      }
      const now = env.now().getTime();
      const last = auditedAt.get(request.ip);
      if (last === undefined || now - last >= MINUTE_MS) {
        auditedAt.set(request.ip, now);
        if (auditedAt.size > 10_000) auditedAt.clear(); // bounded: an address scan cannot grow it forever
        await recordAudit(env.ctx.hooks, env.ctx.db, {
          ...auditSource(request),
          ...ANONYMOUS_SOURCE,
          action: 'auth.sign_in_failed',
          target: { kind: 'server' },
          details: { method: 'scim', reason, emailLower: null },
        });
      }
      return reply
        .code(401)
        .header('www-authenticate', 'Bearer')
        .type(SCIM_MEDIA_TYPE)
        .send(scimError(401, 'A valid SCIM bearer token is required.').body());
    };

    scim.addHook('onRequest', async (request, reply) => {
      const token = bearerOf(request.headers.authorization);
      if (token === undefined) return refuse(request, reply, 'scim-token-missing');
      const hash = hashSecret(token);
      const row = await repo.scimTokenByHash(env.ctx.db, hash);
      if (row === undefined || !sameHash(row.tokenHash, hash)) return refuse(request, reply, 'scim-token-unknown');
      if (row.revokedAt !== null) return refuse(request, reply, 'scim-token-revoked');
      if (!(await env.ctx.license.state()).features.includes('sso-provisioning')) {
        return reply
          .code(403)
          .type(SCIM_MEDIA_TYPE)
          .send(scimError(403, 'SCIM provisioning needs the sso-provisioning licence feature.').body());
      }
      request.scimToken = { id: row.id };
      const now = env.now();
      if (row.lastUsedAt === null || now.getTime() - Date.parse(row.lastUsedAt) >= MINUTE_MS)
        await repo.touchScimToken(env.ctx.db, row.id, now);
      return undefined;
    });

    // Answers are SCIM documents, whatever the route serialised them as.
    scim.addHook('onSend', async (_request, reply, payload) => {
      const type = reply.getHeader('content-type');
      if (typeof type === 'string' && type.startsWith('application/json'))
        void reply.header('content-type', `${SCIM_MEDIA_TYPE}; charset=utf-8`);
      return payload;
    });

    discoveryRoutes(env)(scim);
    await Promise.resolve();
  };
