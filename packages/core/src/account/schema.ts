/**
 * `userData/accounts.yaml` (identity spec §4.3): the servers this installation knows and who it
 * is signed in as on each. The token itself is never here — `tokenRef` names a secret-store
 * entry — so the file is safe to read by the CLI later and to show in a bug report.
 */
import { z } from 'zod';

export const ACCOUNTS_FILE_VERSION = 1;

export const serverAccountSchema = z.object({
  /** The server's origin, as `GET /api/v1/meta` reports its `publicUrl`. */
  url: z.string().url(),
  userId: z.string(),
  email: z.string(),
  displayName: z.string(),
  deviceName: z.string(),
  /** A `SecretStore` ref (`sec_…`), never the token. */
  tokenRef: z.string().regex(/^sec_[0-9a-f]{26}$/),
  /** Set when the server last answered `identity-unauthenticated`; cleared by a new sign-in. */
  signedOut: z.literal(true).optional(),
  addedAt: z.string(),
});
export type ServerAccount = z.infer<typeof serverAccountSchema>;

export const accountsFileSchema = z.object({
  version: z.literal(ACCOUNTS_FILE_VERSION),
  servers: z.array(serverAccountSchema),
});
export type AccountsFile = z.infer<typeof accountsFileSchema>;

/** A missing, malformed or newer file yields no accounts rather than a crash at start-up. */
export function parseAccountsFile(document: unknown): AccountsFile {
  const parsed = accountsFileSchema.safeParse(document);
  return parsed.success ? parsed.data : { version: ACCOUNTS_FILE_VERSION, servers: [] };
}
