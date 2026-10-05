/**
 * The licensing wire shapes (licensing spec §3.1, §3.3, §3.6). The server verifies and stores a license;
 * the desktop parses a pasted one before sending it and reads the state back. Plain zod only (ADR-0009).
 */
import { z } from 'zod';

export const LICENSE_FORMAT = 'wbl1';
/** `wbl1.<base64url payload>.<base64url signature>`: the shape only; verification is the server's. */
export const LICENSE_TEXT_PATTERN = /^wbl1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
/** Far above any real license line; bounds the body a server admin can send. */
export const LICENSE_TEXT_MAX_LENGTH = 8192;
/** Seats on a server with no license, or a lapsed one. A product term, not a setting. */
export const COMMUNITY_SEATS = 5;
/** Days after `expiresAt` that the license's edition still holds. A product term, not a setting. */
export const GRACE_DAYS = 30;

export const EDITIONS = ['community', 'team', 'enterprise'] as const;
export const editionSchema = z.enum(EDITIONS);
export type Edition = z.infer<typeof editionSchema>;

/** Names a route or module checks. Later modules add `scim`, `policies`, `scheduled-runs`. */
export const FEATURES = ['audit-log'] as const;
export const featureSchema = z.enum(FEATURES);
export type Feature = z.infer<typeof featureSchema>;

export const LICENSE_STATUSES = ['none', 'active', 'grace', 'expired', 'invalid'] as const;
export type LicenseStatus = (typeof LICENSE_STATUSES)[number];
export type LicenseInvalidReason = 'malformed' | 'bad-signature' | 'not-yet-valid' | 'wrong-server';

const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const SERVER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The signed payload. Unknown keys are refused: the format version is what grows the payload.
 * `features` stays a list of strings so that a feature a newer signer names does not make the whole
 * license unreadable to an older server, which grants only the features it knows.
 */
export const licensePayloadSchema = z.strictObject({
  id: z.string().regex(ULID),
  customer: z.string().min(1).max(200),
  edition: z.enum(['team', 'enterprise']),
  seats: z.number().int().positive().nullable(),
  issuedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  features: z.array(z.string().min(1).max(64)).max(64).optional(),
  /** The only server this license verifies on (license-binding spec §3.2). Absent: any server. */
  serverId: z.string().regex(SERVER_ID).optional(),
});
export type LicensePayload = z.infer<typeof licensePayloadSchema>;

/** `GET /license` and the answer to `PUT /license` (§3.3). Fields past `features` are absent with no license. */
export const licenseStateSchema = z.object({
  edition: editionSchema,
  status: z.enum(LICENSE_STATUSES),
  /** `limit: null` is unlimited. */
  seats: z.object({ used: z.number().int().nonnegative(), limit: z.number().int().positive().nullable() }),
  /** The granted set: empty on Community and Team unless the license lists features. Open strings: a newer server may grant a feature this build does not know. */
  features: z.array(z.string()),
  /** The id licenses are bound to. Set by every server that has it; absent from older servers. */
  serverId: z.string().optional(),
  licenseId: z.string().optional(),
  customer: z.string().optional(),
  issuedAt: z.string().optional(),
  expiresAt: z.string().optional(),
  graceUntil: z.string().optional(),
  /** Only with `status: 'invalid'`. Open for the same reason as `features`; the server produces a `LicenseInvalidReason`. */
  reason: z.string().optional(),
  message: z.string().optional(),
});
export type LicenseState = z.infer<typeof licenseStateSchema>;

export const licenseInstallRequestSchema = z.object({ license: z.string().min(1).max(LICENSE_TEXT_MAX_LENGTH) });
export type LicenseInstallRequest = z.infer<typeof licenseInstallRequestSchema>;
