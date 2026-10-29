/**
 * The local agent's pairing wire shapes (hosted edition spec §18.2). A browser user asks the server for a
 * short code, the agent trades it for a pairing that holds its Ed25519 public key, and before serving a tab
 * the agent redeems the single-use nonce the server gave that tab, signing the request with its key. The
 * server's routes validate with these; the agent parses the answers with them. Plain zod only (ADR-0009):
 * the signing itself lives with whoever holds `node:crypto`.
 */
import { z } from 'zod';
import { teamsIdSchema } from './teams.js';

/** Six characters without look-alikes (no `I`, `L`, `O`, `0` or `1`). */
export const AGENT_PAIRING_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const AGENT_PAIRING_CODE_LENGTH = 6;
export const AGENT_PAIRING_CODE_PATTERN = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/;

export const AGENT_LIMITS = {
  /** A pairing code lives ten minutes. */
  codeTtlMs: 10 * 60 * 1000,
  /** A tab's nonce lives a minute. */
  nonceTtlMs: 60 * 1000,
  /** How far an agent's signed timestamp may be from the server's clock, either way. */
  clockSkewMs: 60 * 1000,
  agentIdMaxLength: 128,
  /** Base64 SPKI DER of an Ed25519 key is 60 characters; the bound only keeps junk out. */
  publicKeyMaxLength: 256,
} as const;

/** The headers on every request the agent signs: redeem, and an unpair or port change from the agent's side. */
export const AGENT_HEADERS = {
  pairing: 'x-wirebench-agent-pairing',
  timestamp: 'x-wirebench-agent-timestamp',
  signature: 'x-wirebench-agent-signature',
} as const;

/** The UTF-8 text the agent signs to redeem a nonce: `nonce\npairingId\ntimestamp` (ISO-8601). */
export function agentRedeemMessage(nonce: string, pairingId: string, timestamp: string): string {
  return `${nonce}\n${pairingId}\n${timestamp}`;
}

/** Hex `sha256` of an empty body: what a `DELETE` signs as its body hash. */
export const AGENT_EMPTY_BODY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

/**
 * The text the agent signs for a request without a nonce (`DELETE` or `PATCH` of its pairing):
 * `METHOD\npath\npairingId\ntimestamp\nbodySha256Hex`. `path` is the request path without its query; the
 * body hash is over the exact bytes sent ({@link AGENT_EMPTY_BODY_SHA256} for none), so a signed port change
 * cannot be replayed with another port.
 */
export function agentRequestMessage(
  method: string,
  path: string,
  pairingId: string,
  timestamp: string,
  bodySha256Hex: string,
): string {
  return `${method.toUpperCase()}\n${path}\n${pairingId}\n${timestamp}\n${bodySha256Hex}`;
}

/** `POST /api/v1/agent/pairing-codes`: the user's one live code, replacing any earlier one. */
export const agentPairingCodeResponseSchema = z.object({
  code: z.string().regex(AGENT_PAIRING_CODE_PATTERN),
  expiresAt: z.string(),
});
export type AgentPairingCodeResponse = z.infer<typeof agentPairingCodeResponseSchema>;

/** `POST /api/v1/agent/pairings`, sent by the agent with no session. */
export const agentPairRequestSchema = z.object({
  /** As the user typed it: case, spaces and dashes are forgiven by the server. */
  code: z.string().min(1).max(32),
  agentId: z.string().min(1).max(AGENT_LIMITS.agentIdMaxLength),
  /** Base64 SPKI DER of the agent's Ed25519 public key. */
  publicKey: z.string().min(1).max(AGENT_LIMITS.publicKeyMaxLength),
  port: z.number().int().min(1).max(65_535),
  sshOptIn: z.boolean(),
});
export type AgentPairRequest = z.infer<typeof agentPairRequestSchema>;

export const agentPairResponseSchema = z.object({
  pairingId: teamsIdSchema,
  /** The server's public URL: the one `Origin` the agent will accept for this pairing. */
  origin: z.string(),
  /** The account the code belonged to, so the agent can say who it paired with. */
  email: z.string(),
});
export type AgentPairResponse = z.infer<typeof agentPairResponseSchema>;

export const agentPairingSchema = z.object({
  id: teamsIdSchema,
  agentId: z.string(),
  port: z.number().int(),
  sshOptIn: z.boolean(),
  createdAt: z.string(),
  lastSeenAt: z.string(),
});
export type AgentPairing = z.infer<typeof agentPairingSchema>;

/** `GET /api/v1/agent/pairings`: the signed-in user's pairings, newest first. */
export const agentPairingsResponseSchema = z.object({ pairings: z.array(agentPairingSchema) });
export type AgentPairingsResponse = z.infer<typeof agentPairingsResponseSchema>;

export const agentPairingParamsSchema = z.object({ id: teamsIdSchema });

/** `POST /api/v1/agent/nonces`: a nonce for one tab to hand its agent. */
export const agentNonceRequestSchema = z.object({ pairingId: teamsIdSchema });
export type AgentNonceRequest = z.infer<typeof agentNonceRequestSchema>;

export const agentNonceResponseSchema = z.object({ nonce: z.string(), expiresAt: z.string() });
export type AgentNonceResponse = z.infer<typeof agentNonceResponseSchema>;

/** `POST /api/v1/agent/nonces/redeem`, signed by the agent (see {@link AGENT_HEADERS}). */
export const agentRedeemRequestSchema = z.object({ nonce: z.string().min(1).max(128) });
export type AgentRedeemRequest = z.infer<typeof agentRedeemRequestSchema>;

/** Who the tab belongs to; the agent serves it as this user. */
export const agentRedeemResponseSchema = z.object({
  userId: teamsIdSchema,
  email: z.string(),
  displayName: z.string(),
});
export type AgentRedeemResponse = z.infer<typeof agentRedeemResponseSchema>;

/** `PATCH /api/v1/agent/pairings/:id`, signed by the agent: it listens on another port now. */
export const agentPortRequestSchema = z.object({ port: z.number().int().min(1).max(65_535) });
export type AgentPortRequest = z.infer<typeof agentPortRequestSchema>;
