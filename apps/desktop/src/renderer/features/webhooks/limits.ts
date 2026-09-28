/**
 * The server's limits on a catch URL's settings (webhook-capture spec §3.5), restated because the
 * renderer imports no engine values. `webhooks-limits.test.ts` pins them to the engine's.
 */
export const CATCH_URL_LIMITS = {
  maxNameLength: 100,
  maxContentTypeLength: 255,
  maxResponseBodyBytes: 65_536,
  maxDelayMs: 30_000,
  minStatus: 200,
  maxStatus: 599,
} as const;

/** The content type's restated character rule (webhook-capture spec §3.5): printable ASCII only. */
export const PRINTABLE_ASCII = /^[\x20-\x7e]+$/;
