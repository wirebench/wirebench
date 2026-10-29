/**
 * Verifying the agent's Ed25519 signatures (hosted edition spec §18.2). The agent sends its public key once,
 * at pairing, as base64 SPKI DER; every later request it signs carries the pairing id, an ISO-8601 timestamp
 * and a base64 signature in the `AGENT_HEADERS`. A timestamp more than a minute from the server's clock, in
 * either direction, is refused before the signature is checked, which bounds how long a captured request
 * can be replayed.
 */
import { createPublicKey, verify, type KeyObject } from 'node:crypto';
import { AGENT_HEADERS, AGENT_LIMITS } from '@wirebench/engine';

/** The key as a `KeyObject`, or `undefined` when the text is not base64 SPKI DER of an Ed25519 key. */
export function parseAgentPublicKey(base64: string): KeyObject | undefined {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) return undefined;
  try {
    const key = createPublicKey({ key: Buffer.from(base64, 'base64'), format: 'der', type: 'spki' });
    return key.asymmetricKeyType === 'ed25519' ? key : undefined;
  } catch {
    return undefined;
  }
}

/** The three agent headers of a request, or `undefined` when any is missing or repeated. */
export interface AgentHeaders {
  readonly pairingId: string;
  readonly timestamp: string;
  readonly signature: string;
}

export function agentHeaders(headers: Record<string, string | string[] | undefined>): AgentHeaders | undefined {
  const one = (name: string): string | undefined => {
    const value = headers[name];
    return typeof value === 'string' && value.length > 0 && value.length <= 256 ? value : undefined;
  };
  const pairingId = one(AGENT_HEADERS.pairing);
  const timestamp = one(AGENT_HEADERS.timestamp);
  const signature = one(AGENT_HEADERS.signature);
  if (pairingId === undefined || timestamp === undefined || signature === undefined) return undefined;
  return { pairingId, timestamp, signature };
}

/** Whether `timestamp` is ISO-8601 and within {@link AGENT_LIMITS.clockSkewMs} of `now`. */
export function timestampFresh(timestamp: string, now: Date): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/.test(timestamp)) return false;
  const at = Date.parse(timestamp);
  return Number.isFinite(at) && Math.abs(now.getTime() - at) <= AGENT_LIMITS.clockSkewMs;
}

/** Whether `signature` (base64) is the Ed25519 signature of `message`'s UTF-8 bytes under `publicKey`. */
export function signatureValid(publicKey: string, message: string, signature: string): boolean {
  const key = parseAgentPublicKey(publicKey);
  if (key === undefined || !/^[A-Za-z0-9+/]+={0,2}$/.test(signature)) return false;
  const bytes = Buffer.from(signature, 'base64');
  if (bytes.length !== 64) return false;
  try {
    return verify(null, Buffer.from(message, 'utf8'), key, bytes);
  } catch {
    return false;
  }
}

export type AgentSignatureFailure = 'timestamp' | 'signature';

/** Checks a signed request: the timestamp first, then the signature over `message`. `undefined` means it holds. */
export function checkAgentSignature(
  input: {
    readonly publicKey: string;
    readonly message: string;
    readonly timestamp: string;
    readonly signature: string;
  },
  now: Date,
): AgentSignatureFailure | undefined {
  if (!timestampFresh(input.timestamp, now)) return 'timestamp';
  if (!signatureValid(input.publicKey, input.message, input.signature)) return 'signature';
  return undefined;
}
