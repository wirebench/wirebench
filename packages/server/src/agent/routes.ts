/**
 * The pairing routes (hosted edition spec §18.2), under `/api/v1/agent`.
 *
 * - The browser's routes need a cookie session (`via: 'cookie'`); identity's guard already refuses a
 *   cookie write whose `Origin` is not the public URL. A bearer caller is treated as not signed in.
 * - `POST /pairings` has no session: the code is the credential. It is rate-limited per address.
 * - The agent's own requests (redeem, and an unpair or port change from its side) carry the
 *   `AGENT_HEADERS` and are verified against the pairing's Ed25519 key (`signature.ts`).
 *
 * Ruling on "the fifth wrong code deletes that user's code": a wrong code at `POST /pairings` cannot be
 * tied to any user or code. The request carries only the code, lookup is by its hash, and a wrong guess
 * matches no row, so there is no counter it could charge. Asking the agent for the user's email as well would
 * make attempts attributable, but `wirebench agent pair <code>` would then need the email too. So guessing
 * is bounded instead by the per-address limit, five attempts in ten minutes (the life of a code), against
 * 31^6 ≈ 887 million codes. `agent_pairing_codes.attempts` stays in the schema for a lookup that can
 * attribute.
 */
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
import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify';
import { announce, auditSource, recordAudit, type AuditInput, type Querier, type ServerContext } from '../context.js';
import { isUniqueViolation } from '../db/errors.js';
import { unauthenticated } from '../identity/errors.js';
import { RateLimiter, ipKey, rateLimit } from '../identity/rate-limit.js';
import { findUserById } from '../identity/repo.js';
import { hashSecret, mintSecret, newId } from '../identity/tokens.js';
import { problem } from '../problem.js';
import { jsonSchema } from '../schema.js';
import { hashPairingCode, newPairingCode, normalizePairingCode } from './codes.js';
import { nonceInvalid, pairingCodeInvalid, pairingUnknown, signatureInvalid } from './errors.js';
import * as repo from './repo.js';
import type { PairingRow } from './repo.js';
import { agentHeaders, checkAgentSignature, parseAgentPublicKey } from './signature.js';

export interface AgentRoutesEnv {
  readonly ctx: ServerContext;
  readonly now: () => Date;
}

/** Why a redeem was refused, as `agent.nonce.refused` records it; never the nonce itself. */
type RefusedReason = 'headers' | 'unknown-pairing' | 'timestamp' | 'signature' | 'nonce' | 'user';

/** `POST /pairings` per address: five in ten minutes, a code's whole life. */
export const PAIR_ATTEMPTS = { capacity: 5, windowMs: 10 * 60 * 1000 } as const;

const CODE_COLLISION_RETRIES = 3;

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

const wire = (pairing: PairingRow): AgentPairingsResponse['pairings'][number] => ({
  id: pairing.id,
  agentId: pairing.agentId,
  port: pairing.port,
  sshOptIn: pairing.sshOptIn,
  createdAt: pairing.createdAt,
  lastSeenAt: pairing.lastSeenAt,
});

export function agentRoutes(env: AgentRoutesEnv): (app: FastifyInstance) => void {
  const { ctx, now } = env;
  const { db, hooks } = ctx;
  const limiter = new RateLimiter({
    capacity: PAIR_ATTEMPTS.capacity,
    refillPerMs: PAIR_ATTEMPTS.capacity / PAIR_ATTEMPTS.windowMs,
    now: () => now().getTime(),
  });

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

  const refusalError = (reason: RefusedReason): Error => {
    if (reason === 'unknown-pairing') return pairingUnknown();
    if (reason === 'nonce' || reason === 'user') return nonceInvalid();
    return signatureInvalid();
  };

  return (app) => {
    app.post('/agent/pairing-codes', { preHandler: requireBrowser }, async (request, reply) => {
      const caller = browserCaller(request);
      const expiresAt = new Date(now().getTime() + AGENT_LIMITS.codeTtlMs);
      for (let attempt = 0; ; attempt++) {
        const code = newPairingCode();
        try {
          await repo.replaceCode(db, { userId: caller.id, codeHash: hashPairingCode(code), expiresAt });
        } catch (error) {
          // Another user's live code has the same hash: one in 887 million, so draw again.
          if (attempt < CODE_COLLISION_RETRIES && isUniqueViolation(error, 'agent_pairing_codes_pkey')) continue;
          throw error;
        }
        const answer: AgentPairingCodeResponse = { code, expiresAt: expiresAt.toISOString() };
        return reply.code(201).send(answer);
      }
    });

    app.post(
      '/agent/pairings',
      {
        // The agent has no session; a stale cookie in the request must neither sign it in nor refuse it.
        config: { cookieAuth: false },
        preHandler: rateLimit({ limiter }, (request) => [ipKey(request)]),
        schema: { body: jsonSchema(agentPairRequestSchema, { io: 'input' }) },
      },
      async (request, reply) => {
        const body = request.body as AgentPairRequest;
        const code = normalizePairingCode(body.code);
        if (code === undefined) throw pairingCodeInvalid();
        // Checked before the code is taken, so a malformed key does not cost the user their code.
        if (parseAgentPublicKey(body.publicKey) === undefined) {
          throw problem('invalid-request', 'The public key is not an Ed25519 key in base64 SPKI DER.', 400);
        }
        const pairing = await db.transaction(async (tx) => {
          const userId = await repo.takeCode(tx, hashPairingCode(code), now());
          if (userId === undefined) return undefined;
          const user = await findUserById(tx, userId);
          if (user === undefined || user.disabledAt !== null) return undefined;
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
            details: { agentId: row.agentId, port: row.port, sshOptIn: row.sshOptIn },
          });
          return row;
        });
        if (pairing === undefined) throw pairingCodeInvalid();
        const answer: AgentPairResponse = { pairingId: pairing.id, origin: ctx.config.publicUrl };
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
      { config: { cookieAuth: false }, schema: { body: jsonSchema(agentRedeemRequestSchema, { io: 'input' }) } },
      async (request) => {
        const { nonce } = request.body as AgentRedeemRequest;
        const refuse = async (reason: RefusedReason, pairing?: PairingRow): Promise<never> => {
          await db.transaction((tx) =>
            recordAudit(hooks, tx, {
              ...auditSource(request),
              actor: { kind: 'anonymous' },
              action: 'agent.nonce.refused',
              target: { kind: 'agent-pairing', ...(pairing !== undefined ? { id: pairing.id } : {}) },
              details: { reason },
            }),
          );
          throw refusalError(reason);
        };
        const verified = await verifiedAgent(request, (pairingId, timestamp) =>
          agentRedeemMessage(nonce, pairingId, timestamp),
        );
        if ('refused' in verified) return refuse(verified.refused, verified.pairing);
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
            action: 'agent.nonce.redeemed',
            target: { kind: 'agent-pairing', id: pairing.id },
            details: { agentId: pairing.agentId },
          });
          const answer: AgentRedeemResponse = { userId, email: user.email, displayName: user.displayName };
          return { answer };
        });
        if ('refused' in redeemed) return refuse(redeemed.refused, pairing);
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
          const verified = await verifiedAgent(request, (pairingId, timestamp) =>
            agentRequestMessage('DELETE', pathOf(request), pairingId, timestamp),
          );
          if ('refused' in verified) throw refusalError(verified.refused);
          if (verified.pairing.id !== id) throw signatureInvalid();
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
        const verified = await verifiedAgent(request, (pairingId, timestamp) =>
          agentRequestMessage('PATCH', pathOf(request), pairingId, timestamp),
        );
        if ('refused' in verified) throw refusalError(verified.refused);
        if (verified.pairing.id !== id) throw signatureInvalid();
        await repo.setPort(db, id, port, now());
        return reply.code(204).send();
      },
    );
  };
}
