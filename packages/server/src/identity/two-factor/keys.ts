/**
 * The keys two-step sign-in seals and hashes under (spec §7): HKDF-SHA-256 over the tenant's data key, salted for
 * this use and bound to the person and the purpose, so a sealed secret or a code hash copied to another person,
 * another purpose or another tenant does not open or match.
 */
import { hkdfSync } from 'node:crypto';
import { open, seal } from '../../hooks/secret-box.js';

/** HKDF's salt; changing it orphans every sealed authenticator secret and recovery code. */
const SALT = 'wirebench-two-factor';

export function twoFactorKey(dataKey: Buffer, userId: string, use: 'totp' | 'recovery'): Buffer {
  return Buffer.from(hkdfSync('sha256', dataKey, SALT, `${use}:${userId}`, 32));
}

export function sealTotpSecret(dataKey: Buffer, userId: string, secret: Buffer): Buffer {
  return seal(twoFactorKey(dataKey, userId, 'totp'), secret.toString('base64'));
}

/** @throws Error when the box does not open under this person's key in this tenant. */
export function openTotpSecret(dataKey: Buffer, userId: string, sealed: Buffer): Buffer {
  return Buffer.from(open(twoFactorKey(dataKey, userId, 'totp'), sealed), 'base64');
}
