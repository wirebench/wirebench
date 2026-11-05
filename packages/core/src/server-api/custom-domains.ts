/**
 * The custom-domain wire shapes (hosted edition spec §23.6): a hosted tenant's one name of its own, its two DNS
 * records and where its check stands. The server's routes answer with these and the desktop's Domain tab parses
 * them. Plain zod only (ADR-0009).
 *
 * The TXT record's value holds the claim's token, and it reaches only the claiming tenant's own server admins: no
 * shape here says which tenant holds a name.
 */
import { z } from 'zod';

/** A DNS name is at most 253 characters. */
export const CUSTOM_DOMAIN_NAME_MAX_LENGTH = 253;

/** The states of §23.2, in the order the spec's table lists them. */
export const CUSTOM_DOMAIN_STATES = [
  'pending',
  'verified',
  'active',
  'failing',
  'lapsed',
  'paused',
  'expired',
] as const;
export const customDomainStateSchema = z.enum(CUSTOM_DOMAIN_STATES);
export type CustomDomainState = z.infer<typeof customDomainStateSchema>;

/** One record's verdict at the last check. */
export const customDomainVerdictSchema = z.enum(['ok', 'missing', 'wrong']);
export type CustomDomainVerdict = z.infer<typeof customDomainVerdictSchema>;

/** One of the two records the tenant creates: the CNAME to `custom.<app-domain>` and the TXT token. */
export const customDomainRecordSchema = z.object({
  type: z.enum(['CNAME', 'TXT']),
  name: z.string(),
  value: z.string(),
});
export type CustomDomainRecord = z.infer<typeof customDomainRecordSchema>;

/** What the last check saw. `heldElsewhere`: both records passed, but another team holds the name (never which). */
export const customDomainResultSchema = z.object({
  cname: customDomainVerdictSchema,
  txt: customDomainVerdictSchema,
  certificate: customDomainVerdictSchema.optional(),
  heldElsewhere: z.literal(true).optional(),
  message: z.string(),
});
export type CustomDomainResult = z.infer<typeof customDomainResultSchema>;

/** The tenant's claim, as `GET`, `PUT` and `POST …/check` answer it. */
export const customDomainSchema = z.object({
  name: z.string(),
  state: customDomainStateSchema,
  records: z.array(customDomainRecordSchema),
  /** `null` until the first check. */
  lastResult: customDomainResultSchema.nullable(),
  /** The last DNS check, ISO 8601; `null` until the first. */
  checkedAt: z.string().nullable(),
});
export type CustomDomain = z.infer<typeof customDomainSchema>;

/** `GET /api/v1/tenant/domain`: the claim, or `{}` when the tenant has none. */
export const customDomainResponseSchema = z.union([customDomainSchema, z.object({}).strict()]);
export type CustomDomainResponse = z.infer<typeof customDomainResponseSchema>;

/** `PUT /api/v1/tenant/domain`: the name to claim. The server checks it with `checkCustomName` (`400` with the reason). */
export const customDomainClaimRequestSchema = z.object({
  name: z.string().min(1).max(CUSTOM_DOMAIN_NAME_MAX_LENGTH),
});
export type CustomDomainClaimRequest = z.infer<typeof customDomainClaimRequestSchema>;
