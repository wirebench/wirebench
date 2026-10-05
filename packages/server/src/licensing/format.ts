/**
 * Offline license verification (licensing spec §3.1, §3.2). Pure: no clock of its own, no I/O. The
 * signature covers the payload segment's text exactly as received, so nothing is re-serialised, and one
 * license line has exactly one valid signature even though base64url decoding is lenient. A license that
 * names a server verifies only on that server, checked after the signature and before the clock
 * (license-binding spec §3.3).
 */
import { verify, type KeyObject } from 'node:crypto';
import {
  LICENSE_FORMAT,
  licensePayloadSchema,
  type LicenseInvalidReason,
  type LicensePayload,
} from '@wirebench/engine';

export type Verified =
  | { readonly ok: true; readonly license: LicensePayload }
  | { readonly ok: false; readonly reason: LicenseInvalidReason; readonly message: string };

const SEGMENT = /^[A-Za-z0-9_-]+$/;

const malformed = (message: string): Verified => ({ ok: false, reason: 'malformed', message });

function signedBy(segment: string, signature: Buffer, publicKeys: readonly KeyObject[]): boolean {
  const data = Buffer.from(segment, 'ascii');
  return publicKeys.some((key) => {
    try {
      return verify(null, data, key, signature);
    } catch {
      return false; // a signature of the wrong length throws on some Node versions
    }
  });
}

/** Expiry is state, not validity (§3.2): a license past `expiresAt` still verifies. */
export function verifyLicense(text: string, publicKeys: readonly KeyObject[], now: Date, serverId: string): Verified {
  const parts = text.trim().split('.');
  if (parts.length !== 3 || parts[0] !== LICENSE_FORMAT) {
    return malformed('This is not a Wirebench license. A license is one line that starts with "wbl1.".');
  }
  const [, segment, signature] = parts as [string, string, string];
  if (!SEGMENT.test(segment) || !SEGMENT.test(signature)) {
    return malformed('The license contains characters a license never has. Paste the whole line again.');
  }
  if (!signedBy(segment, Buffer.from(signature, 'base64url'), publicKeys)) {
    return {
      ok: false,
      reason: 'bad-signature',
      message: 'The license signature does not match. It was changed, or it was not issued for Wirebench.',
    };
  }
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
  } catch {
    return malformed('The license payload is not readable.');
  }
  const parsed = licensePayloadSchema.safeParse(json);
  if (!parsed.success) return malformed('The license payload is not in a form this server understands.');
  const license = parsed.data;
  if (Date.parse(license.expiresAt) <= Date.parse(license.issuedAt)) {
    return malformed('The license expires before it was issued.');
  }
  if (license.serverId !== undefined && license.serverId !== serverId) {
    return {
      ok: false,
      reason: 'wrong-server',
      message: `This license was issued for server ${license.serverId}. This server is ${serverId}. Ask for a license issued for this server.`,
    };
  }
  if (Date.parse(license.issuedAt) > now.getTime()) {
    return {
      ok: false,
      reason: 'not-yet-valid',
      message: `The license was issued at ${license.issuedAt}, which is after this server's clock (${now.toISOString()}). Check the server clock.`,
    };
  }
  return { ok: true, license };
}
