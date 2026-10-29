/**
 * Pairing codes (hosted edition spec §18.2). A code is six characters from an alphabet without look-alikes,
 * short enough to type from one screen into another. With only 31^6 of them, a plain hash would be reversed
 * by trying them all, so the database keeps an HMAC under a key derived from `WIREBENCH_SERVER_SECRETS_KEY`
 * (which the browser client already requires). A code is looked up by that HMAC, so a guess can never
 * reveal another user's code.
 */
import { createHmac, hkdfSync, randomInt } from 'node:crypto';
import { AGENT_PAIRING_CODE_ALPHABET, AGENT_PAIRING_CODE_LENGTH, AGENT_PAIRING_CODE_PATTERN } from '@wirebench/engine';

const CODE_KEY_INFO = 'wirebench-agent-pairing-codes';

/** A fresh code: each character drawn uniformly from the alphabet. */
export function newPairingCode(): string {
  let code = '';
  for (let i = 0; i < AGENT_PAIRING_CODE_LENGTH; i++) {
    code += AGENT_PAIRING_CODE_ALPHABET[randomInt(AGENT_PAIRING_CODE_ALPHABET.length)];
  }
  return code;
}

/**
 * The code as the user typed it, upper-cased and without spaces or dashes, or `undefined` when it cannot be
 * a code at all (no query is made for that).
 */
export function normalizePairingCode(typed: string): string | undefined {
  const code = typed.replace(/[\s-]/g, '').toUpperCase();
  return AGENT_PAIRING_CODE_PATTERN.test(code) ? code : undefined;
}

/** HMAC-SHA256 of a normalised code, hex, under a key HKDF derives from the server's secrets key. */
export function pairingCodeHasher(secretsKey: Buffer): (code: string) => string {
  const key = Buffer.from(hkdfSync('sha256', secretsKey, Buffer.alloc(0), CODE_KEY_INFO, 32));
  return (code) => createHmac('sha256', key).update(code, 'utf8').digest('hex');
}
