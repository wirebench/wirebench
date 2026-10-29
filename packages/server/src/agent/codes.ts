/**
 * Pairing codes and tab nonces (hosted edition spec §18.2). A code is six characters from an alphabet
 * without look-alikes, short enough to type from one screen into another; a nonce is long random material.
 * The database keeps only `sha256` of either, and looks a code up by that hash, so a guess can never
 * reveal another user's code.
 */
import { randomInt } from 'node:crypto';
import { AGENT_PAIRING_CODE_ALPHABET, AGENT_PAIRING_CODE_LENGTH, AGENT_PAIRING_CODE_PATTERN } from '@wirebench/engine';
import { hashSecret } from '../identity/tokens.js';

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

export const hashPairingCode = (code: string): string => hashSecret(code);
