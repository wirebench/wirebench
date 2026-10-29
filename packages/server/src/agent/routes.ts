/**
 * The pairing routes (hosted edition spec §18.2), under `/api/v1/agent`.
 *
 * - The browser's routes need a cookie session (`via: 'cookie'`); identity's guard already refuses a
 *   cookie write whose `Origin` is not the public URL. A bearer caller is treated as not signed in.
 * - `POST /pairings` has no session: the code is the credential. It is limited per address, and failures
 *   are limited server-wide (below).
 * - The agent's own requests (redeem, and an unpair or port change from its side) carry the
 *   `AGENT_HEADERS` and are verified against the pairing's Ed25519 key (`signature.ts`). A `DELETE` or
 *   `PATCH` signs the hash of its exact body bytes, so these routes sit in a scope of their own whose JSON
 *   parser keeps the raw body.
 *
 * A wrong code cannot be tied to any user or code: the request carries only the code, lookup is by its
 * HMAC, and a wrong guess matches no row. So guessing is bounded by two limits instead: five attempts per
 * address in ten minutes (the life of a code), and 50 failed attempts server-wide in ten minutes, after
 * which pairing answers 429 for everyone until the window refills. Against 31^6 ≈ 887 million codes that
 * keeps a distributed guess hopeless.
 */
import { createHash } from 'node:crypto';
import {
  AGENT_LIMITS,
  TEAMS_ID_PATTERN,
  agentNonceRequestSchema,
  agentPairRequestSchema,
  agentPairingParamsSchema,
  agentPortRequestSchema,
  agentRedeemMessage,
  agentRedeemRequestSchema,
  agentRequestMessage,
  type AgentNonceRequest,
  type AgentNonceResponse,
  type AgentPairRequest,
  type AgentPairResponse,
  type AgentPairingCodeResponse,
  type AgentPairingsResponse,
  type AgentPortRequest,
  type AgentRedeemRequest,
  type AgentRedeemResponse,
} from '@wirebench/engine';
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import { announce, auditSource, recordAudit, type AuditInput, type Querier, type ServerContext } from '../context.js';
import { isUniqueViolation } from '../db/errors.js';
import { unauthenticated } from '../identity/errors.js';
import { RateLimiter, callerKey, ipKey, rateLimit } from '../identity/rate-limit.js';
import { findUserById } from '../identity/repo.js';
import { hashSecret, mintSecret, newId } from '../identity/tokens.js';
import { problem } from '../problem.js';
import { jsonSchema } from '../schema.js';
import { newPairingCode, normalizePairingCode, pairingCodeHasher } from './codes.js';
import { nonceInvalid, pairingCodeInvalid, pairingUnknown, signatureInvalid } from './errors.js';
import * as repo from './repo.js';
import type { PairingRow } from './repo.js';
import { agentHeaders, checkAgentSignature, parseAgentPublicKey } from './signature.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** The exact JSON body text, kept by the agent scope's parser so a signed body hash can be checked. */
    agentBody?: string;
  }
}

export interface AgentRoutesEnv {
  readonly ctx: ServerContext;
  readonly now: () => Date;
  /** `WIREBENCH_SERVER_SECRETS_KEY`, which the browser client requires: the pairing codes' HMAC key derives from it. */
  readonly secretsKey: Buffer;
}

/** Why an agent-signed request was refused, as the audit records it; never the nonce itself. */
type RefusedReason = 'headers' | 'unknown-pairing' | 'timestamp' | 'signature' | 'pairing-mismatch' | 'nonce' | 'user';

const TEN_MINUTES = 10 * 60 * 1000;

/** The route limits (hosted edition spec §18.2): capacity per window, refilled continuously. */
export const AGENT_RATE_LIMITS = {
  /** `POST /pairings` per address: five in ten minutes, a code's whole life. */
  pairPerAddress: { capacity: 5, windowMs: TEN_MINUTES },
  /** Failed `POST /pairings` across the whole server; when spent, pairing answers 429 for everyone. */
  pairFailures: { capacity: 50, windowMs: TEN_MINUTES },
  /** `POST /pairing-codes` per user. */
  codesPerUser: { capacity: 10, windowMs: TEN_MINUTES },
  /** `POST /nonces/redeem` per address: a tab redeems once when it opens. */
  redeemPerAddress: { capacity: 30, windowMs: 60 * 1000 },
} as const;

const CODE_COLLISION_RETRIES = 3;
const ALL = 'all';

const limiterFor = (limit: { capacity: number; windowMs: number }, now: () => Date): RateLimiter =>
  new RateLimiter({
    capacity: limit.capacity,
    refillPerMs: limit.capacity / limit.windowMs,
    now: () => now().getTime(),
  });

const RATE_LIMITED = { code: 'identity-rate-limited', message: 'Too many attempts. Try again shortly.' } as const;

/** A browser session only: a desktop's or a script's bearer token is not a tab. */
const requireBrowser: preHandlerHookHandler = (request, _reply, done) => {
  done(request.caller?.via === 'cookie' ? undefined : unauthenticated());
};

function browserCaller(request: FastifyRequest): { readonly id: string; readonly email: string } {
  const caller = request.caller;
  if (caller?.via !== 'cookie') throw unauthenticated();
  return caller;
}

/** The request's path without its query: what the agent signs for a `DELETE` or `PATCH`. */
const pathOf = (request: FastifyRequest): string => request.url.split('?', 1)[0]!;

/** Hex `sha256` of the body bytes as received; an empty body for none. */
const bodyHash = (request: FastifyRequest): string =>
  createHash('sha256')
    .update(request.agentBody ?? '', 'utf8')
    .digest('hex');

const wire = (pairing: PairingRow): AgentPairingsResponse['pairings'][number] => ({
  id: pairing.id,
  agentId: pairing.agentId,
  port: pairing.port,
  sshOptIn: pairing.sshOptIn,
  createdAt: pairing.createdAt,
  lastSeenAt: pairing.lastSeenAt,
});

/** The pairing routes, registered in a scope of their own (see the module header) under the caller's prefix. */
export function agentRoutes(env: AgentRoutesEnv): (app: FastifyInstance) => Promise<void> {
  const { ctx, now } = env;
  const { db, hooks } = ctx;
  const hashCode = pairingCodeHasher(env.secretsKey);
  const pairPerAddress = limiterFor(AGENT_RATE_LIMITS.pairPerAddress, now);
  const pairFailures = limiterFor(AGENT_RATE_LIMITS.pairFailures, now);
  const codesPerUser = limiterFor(AGENT_RATE_LIMITS.codesPerUser, now);
  const redeemPerAddress = limiterFor(AGENT_RATE_LIMITS.redeemPerAddress, now);

  /** The pairing's user as the actor of what its agent did (the agent acts for them). */
  const asUser = async (tx: Querier, userId: string): Promise<AuditInput['actor']> => {
    const user = await findUserById(tx, userId);
    return user === undefined ? { kind: 'anonymous' } : { kind: 'user', userId, email: user.email };
  };

  /**
   * Checks the agent headers of a request against the pairing named in them, and answers the pairing. The
   * timestamp and signature are checked before anything is consumed, so a forged request burns nothing.
   */
  const verifiedAgent = async (
    request: FastifyRequest,
    message: (pairingId: string, timestamp: string) => string,
  ): Promise<{ pairing: PairingRow } | { refused: RefusedReason; pairing?: PairingRow }> => {
    const headers = agentHeaders(request.headers);
    if (headers === undefined || !TEAMS_ID_PATTERN.test(headers.pairingId)) return { refused: 'headers' };
    const pairing = await repo.pairingById(db, headers.pairingId);
    if (pairing === undefined) return { refused: 'unknown-pairing' };
    const failure = checkAgentSignature(
      {
        publicKey: pairing.publicKey,
        message: message(pairing.id, headers.timestamp),
        timestamp: headers.timestamp,
        signature: headers.signature,
      },
      now(),
    );
    return failure === undefined ? { pairing } : { refused: failure, pairing };
  };

  /** Records a refusal in its own transaction: the request fails, the audit row stays. */
  const auditRefusal = (event: AuditInput): Promise<void> => db.transaction((tx) => recordAudit(hooks, tx, event));

  /** Answers 429 while the server-wide failed-pairing bucket is empty; it is charged only on a failure. */
  const pairingOpen = (_request: FastifyRequest, reply: FastifyReply, done: (error?: Error) => void): void => {
    const decision = pairFailures.peek(ALL);
    if (!decision.allowed) {
      void reply.header('retry-after', String(decision.retryAfterSeconds)).code(429).send(RATE_LIMITED);
      return;
    }
    done();
  };

  /**
   * An agent-signed `DELETE` or `PATCH` of pairing `id`, or the refusal to throw. A refusal against a known
   * pairing is audited as `agent.request_refused`; malformed headers and unknown pairings only log.
   */
  const verifiedRequest = async (
    request: FastifyRequest,
    method: 'DELETE' | 'PATCH',
    id: string,
  ): Promise<PairingRow> => {
    const verified = await verifiedAgent(request, (pairingId, timestamp) =>
      agentRequestMessage(method, pathOf(request), pairingId, timestamp, bodyHash(request)),
    );
    if (!('refused' in verified) && verified.pairing.id === id) return verified.pairing;
    const refused: RefusedReason = 'refused' in verified ? verified.refused : 'pairing-mismatch';
    if (verified.pairing === undefined) {
      request.log.debug({ reason: refused, method }, 'agent request refused');
      throw refused === 'unknown-pairing' ? pairingUnknown() : signatureInvalid();
    }
    await auditRefusal({
      ...auditSource(request),
      actor: { kind: 'anonymous' },
      action: 'agent.request_refused',
      target: { kind: 'agent-pairing', id: verified.pairing.id },
      details: { method, reason: refused },
    });
    throw signatureInvalid();
  };

  return async (root) => {
    await root.register((app: FastifyInstance, _options, ready) => {
      // The body text as well as its value, for the signed body hash; parsing is Fastify's own.
      const parseJson = app.getDefaultJsonParser('error', 'error');
      app.removeContentTypeParser('application/json');
      app.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
        const text = body as string;
        request.agentBody = text;
        // Fastify's parser answers through `done`; its type also allows a promise, which it never returns here.
        void parseJson(request, text, done);
      });
      routes(app);
      ready();
    });
  };

  function routes(app: FastifyInstance): void {
    app.post(
      '/agent/pairing-codes',
      { preHandler: [requireBrowser, rateLimit({ limiter: codesPerUser }, (request) => [callerKey(request)])] },
      async (request, reply) => {
        const caller = browserCaller(request);
        const expiresAt = new Date(now().getTime() + AGENT_LIMITS.codeTtlMs);
        for (let attempt = 0; ; attempt++) {
          const code = newPairingCode();
          try {
            await repo.replaceCode(db, { userId: caller.id, codeHash: hashCode(code), expiresAt });
          } catch (error) {
            // Another user's live code has the same HMAC: one in 887 million, so draw again.
            if (attempt < CODE_COLLISION_RETRIES && isUniqueViolation(error, 'agent_pairing_codes_pkey')) continue;
            throw error;
          }
          const answer: AgentPairingCodeResponse = { code, expiresAt: expiresAt.toISOString() };
          return reply.code(201).send(answer);
        }
      },
    );

    app.post(
      '/agent/pairings',
      {
        // The agent has no session; a stale cookie in the request must neither sign it in nor refuse it.
        config: { cookieAuth: false },
        preHandler: [pairingOpen, rateLimit({ limiter: pairPerAddress }, (request) => [ipKey(request)])],
        schema: { body: jsonSchema(agentPairRequestSchema, { io: 'input' }) },
      },
      async (request, reply) => {
        const body = request.body as AgentPairRequest;
        const failed = (): Error => {
          pairFailures.take(ALL);
          return pairingCodeInvalid();
        };
        const code = normalizePairingCode(body.code);
        if (code === undefined) throw failed();
        // Checked before the code is taken, so a malformed key does not cost the user their code.
        if (parseAgentPublicKey(body.publicKey) === undefined) {
          throw problem('invalid-request', 'The public key is not an Ed25519 key in base64 SPKI DER.', 400);
        }
        const paired = await db.transaction(async (tx) => {
          const userId = await repo.takeCode(tx, hashCode(code), now());
          if (userId === undefined) return undefined;
          const user = await findUserById(tx, userId);
          if (user === undefined || user.disabledAt !== null) return undefined;
          const replaced = (await repo.pairingOfAgent(tx, userId, body.agentId)) !== undefined;
          const row = await repo.upsertPairing(tx, {
            id: newId(),
            userId,
            agentId: body.agentId,
            publicKey: body.publicKey,
            port: body.port,
            sshOptIn: body.sshOptIn,
            at: now(),
          });
          await recordAudit(hooks, tx, {
            ...auditSource(request),
            actor: { kind: 'user', userId, email: user.email },
            action: 'agent.paired',
            target: { kind: 'agent-pairing', id: row.id },
            details: {
              agentId: row.agentId,
              port: row.port,
              sshOptIn: row.sshOptIn,
              ...(replaced ? { replaced: true } : {}),
            },
          });
          return { row, email: user.email };
        });
        if (paired === undefined) throw failed();
        const answer: AgentPairResponse = {
          pairingId: paired.row.id,
          origin: ctx.config.publicUrl,
          email: paired.email,
        };
        return reply.code(201).send(answer);
      },
    );

    app.get('/agent/pairings', { preHandler: requireBrowser }, async (request) => {
      const caller = browserCaller(request);
      const answer: AgentPairingsResponse = { pairings: (await repo.pairingsOfUser(db, caller.id)).map(wire) };
      return answer;
    });

    app.post(
      '/agent/nonces',
      { preHandler: requireBrowser, schema: { body: jsonSchema(agentNonceRequestSchema, { io: 'input' }) } },
      async (request, reply) => {
        const caller = browserCaller(request);
        const { pairingId } = request.body as AgentNonceRequest;
        const pairing = await repo.pairingById(db, pairingId);
        if (pairing === undefined || pairing.userId !== caller.id) throw pairingUnknown();
        const { secret, hash } = mintSecret();
        const expiresAt = new Date(now().getTime() + AGENT_LIMITS.nonceTtlMs);
        await repo.insertNonce(db, { nonceHash: hash, pairingId, userId: caller.id, expiresAt });
        const answer: AgentNonceResponse = { nonce: secret, expiresAt: expiresAt.toISOString() };
        return reply.code(201).send(answer);
      },
    );

    app.post(
      '/agent/nonces/redeem',
      {
        config: { cookieAuth: false },
        preHandler: rateLimit({ limiter: redeemPerAddress }, (request) => [ipKey(request)]),
        schema: { body: jsonSchema(agentRedeemRequestSchema, { io: 'input' }) },
      },
      async (request) => {
        const { nonce } = request.body as AgentRedeemRequest;
        const verified = await verifiedAgent(request, (pairingId, timestamp) =>
          agentRedeemMessage(nonce, pairingId, timestamp),
        );
        if ('refused' in verified) {
          const { refused, pairing } = verified;
          // No pairing involved: nothing to audit. An unknown pairing answers as a bad signature, so ids cannot be probed.
          if (pairing === undefined) {
            request.log.debug({ reason: refused }, 'agent nonce redeem refused');
            throw signatureInvalid();
          }
          await auditRefusal({
            ...auditSource(request),
            actor: { kind: 'anonymous' },
            action: 'agent.nonce_refused',
            target: { kind: 'agent-pairing', id: pairing.id },
            details: { reason: refused },
          });
          throw signatureInvalid();
        }
        const { pairing } = verified;
        const redeemed = await db.transaction(async (tx) => {
          const userId = await repo.takeNonce(tx, { nonceHash: hashSecret(nonce), pairingId: pairing.id, now: now() });
          if (userId === undefined) return { refused: 'nonce' as const };
          const user = await findUserById(tx, userId);
          if (user === undefined || user.disabledAt !== null) return { refused: 'user' as const };
          await repo.touchPairing(tx, pairing.id, now());
          await recordAudit(hooks, tx, {
            ...auditSource(request),
            actor: { kind: 'user', userId, email: user.email },
            action: 'agent.nonce_redeemed',
            target: { kind: 'agent-pairing', id: pairing.id },
            details: { agentId: pairing.agentId },
          });
          const answer: AgentRedeemResponse = { userId, email: user.email, displayName: user.displayName };
          return { answer };
        });
        if ('refused' in redeemed) {
          const reason = redeemed.refused;
          // The signature held, so the refusal is the pairing's user's.
          await db.transaction(async (tx) =>
            recordAudit(hooks, tx, {
              ...auditSource(request),
              actor: await asUser(tx, pairing.userId),
              action: 'agent.nonce_refused',
              target: { kind: 'agent-pairing', id: pairing.id },
              details: { reason },
            }),
          );
          throw nonceInvalid();
        }
        return redeemed.answer;
      },
    );

    app.delete(
      '/agent/pairings/:id',
      { schema: { params: jsonSchema(agentPairingParamsSchema, { io: 'input' }) } },
      async (request, reply) => {
        const { id } = request.params as { id: string };
        let by: 'agent' | 'user';
        if (agentHeaders(request.headers) !== undefined) {
          await verifiedRequest(request, 'DELETE', id);
          by = 'agent';
        } else {
          const caller = browserCaller(request);
          const pairing = await repo.pairingById(db, id);
          if (pairing === undefined || pairing.userId !== caller.id) throw pairingUnknown();
          by = 'user';
        }
        const removed = await db.transaction(async (tx) => {
          const row = await repo.deletePairing(tx, id);
          if (row === undefined) return undefined;
          await recordAudit(hooks, tx, {
            ...auditSource(request),
            ...(by === 'agent' ? { actor: await asUser(tx, row.userId) } : {}),
            action: 'agent.unpaired',
            target: { kind: 'agent-pairing', id: row.id },
            details: { agentId: row.agentId, by },
          });
          return row;
        });
        if (removed === undefined) throw pairingUnknown();
        announce(hooks.agentUnpaired, { pairingId: removed.id, userId: removed.userId }, request.log);
        return reply.code(204).send();
      },
    );

    app.patch(
      '/agent/pairings/:id',
      {
        config: { cookieAuth: false },
        schema: {
          params: jsonSchema(agentPairingParamsSchema, { io: 'input' }),
          body: jsonSchema(agentPortRequestSchema, { io: 'input' }),
        },
      },
      async (request, reply) => {
        const { id } = request.params as { id: string };
        const { port } = request.body as AgentPortRequest;
        const pairing = await verifiedRequest(request, 'PATCH', id);
        await db.transaction(async (tx) => {
          await repo.setPort(tx, id, port, now());
          await recordAudit(hooks, tx, {
            ...auditSource(request),
            actor: await asUser(tx, pairing.userId),
            action: 'agent.port_changed',
            target: { kind: 'agent-pairing', id },
            details: { agentId: pairing.agentId, from: pairing.port, to: port },
          });
        });
        return reply.code(204).send();
      },
    );
  }
}
