/**
 * The agent's Ed25519 key (hosted edition spec §18.2): one per agent install, made at the first pairing.
 * The server holds the public half from the pairing on, and every request the agent makes after it
 * (redeeming a tab's nonce, a port change, an unpair) is signed with the private half, so a page cannot
 * redeem a nonce for itself. Only `node:crypto`, no dependency.
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { AGENT_HEADERS } from '@wirebench/engine';

/** The agent's key, with the private half kept inside: nothing reads it back but {@link sealable}. */
export interface AgentKey {
  /** Base64 SPKI DER, as the pairing request sends it. */
  readonly publicKey: string;
  /** Base64 Ed25519 signature of `message`'s UTF-8 bytes. */
  sign(message: string): string;
  /** Base64 PKCS8 DER of the private key: only for the pairing store to seal. */
  sealable(): string;
}

function keyFrom(privateKey: KeyObject): AgentKey {
  const publicKey = createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).toString('base64');
  return {
    publicKey,
    sign: (message) => sign(null, Buffer.from(message, 'utf8'), privateKey).toString('base64'),
    sealable: () => privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
  };
}

/** A new key. */
export function generateAgentKey(): AgentKey {
  return keyFrom(generateKeyPairSync('ed25519').privateKey);
}

/** The key from {@link AgentKey.sealable}'s text; throws when it is not an Ed25519 PKCS8 key. */
export function agentKeyFromPkcs8(base64: string): AgentKey {
  const privateKey = createPrivateKey({ key: Buffer.from(base64, 'base64'), format: 'der', type: 'pkcs8' });
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('The agent key is not an Ed25519 key');
  return keyFrom(privateKey);
}

/** Hex SHA-256 of `body`'s bytes: what a signed `PATCH` or `DELETE` signs as its body hash. */
export function bodySha256(body: string | Buffer): string {
  return createHash('sha256').update(body).digest('hex');
}

/** The three signed-request headers for `message`, signed now. */
export function signedHeaders(
  key: AgentKey,
  pairingId: string,
  message: (timestamp: string) => string,
  now: Date = new Date(),
): Record<string, string> {
  const timestamp = now.toISOString();
  return {
    [AGENT_HEADERS.pairing]: pairingId,
    [AGENT_HEADERS.timestamp]: timestamp,
    [AGENT_HEADERS.signature]: key.sign(message(timestamp)),
  };
}
