/**
 * `userData/accounts.yaml` (identity spec §4.3, switch accounts spec §6): the accounts this installation
 * knows — one person on one server each, so two may share a server — and which of them is active. The token
 * itself is never here — `tokenRef` names a secret-store entry — so the file is safe to read by the CLI later
 * and to show in a bug report.
 */
import { z } from 'zod';

/** What is written: always version 2. Version 1 (one account per server, no `active`) is still read. */
export const ACCOUNTS_FILE_VERSION = 2;

/** One account: a person (`userId`) on a server (`url`). */
export const accountRefSchema = z.object({ url: z.string().url(), userId: z.string() });
export type AccountRef = z.infer<typeof accountRefSchema>;

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
  /** User profile spec §7: kept beside the name so the account menu needs no call; absent when none is set. */
  username: z.string().optional(),
  photo: z.object({ version: z.string() }).optional(),
  /** When the account was last made active (switch accounts ruling 2); orders the *Switch accounts* list. */
  lastActiveAt: z.string().optional(),
});
export type ServerAccount = z.infer<typeof serverAccountSchema>;

const sameAccount = (a: AccountRef, b: AccountRef): boolean => a.url === b.url && a.userId === b.userId;

/** No two entries for one person on one server. */
function uniqueAccounts(servers: readonly ServerAccount[], ctx: z.RefinementCtx): void {
  servers.forEach((server, index) => {
    if (servers.findIndex((other) => sameAccount(other, server)) !== index)
      ctx.addIssue({ code: 'custom', path: ['servers', index], message: 'Duplicate account' });
  });
}

export const accountsFileV1Schema = z
  .object({ version: z.literal(1), servers: z.array(serverAccountSchema) })
  .superRefine((file, ctx) => uniqueAccounts(file.servers, ctx));

const accountsFileShape = z.object({
  version: z.literal(ACCOUNTS_FILE_VERSION),
  /** The active account; it names a signed-in entry, or is `null` when none is signed in. */
  active: accountRefSchema.nullable(),
  servers: z.array(serverAccountSchema),
});

/** The first signed-in entry, as a ref; `null` when none is. */
function firstSignedIn(servers: readonly ServerAccount[]): AccountRef | null {
  const first = servers.find((server) => server.signedOut !== true);
  return first === undefined ? null : { url: first.url, userId: first.userId };
}

function activeIsSignedIn(file: z.infer<typeof accountsFileShape>): boolean {
  const { active } = file;
  if (active === null) return true;
  const entry = file.servers.find((server) => sameAccount(server, active));
  return entry !== undefined && entry.signedOut !== true;
}

export const accountsFileSchema = accountsFileShape.superRefine((file, ctx) => {
  uniqueAccounts(file.servers, ctx);
  if (!activeIsSignedIn(file))
    ctx.addIssue({ code: 'custom', path: ['active'], message: 'The active account must be a signed-in entry' });
});
export type AccountsFile = z.infer<typeof accountsFileSchema>;

/**
 * A missing, malformed or newer file yields no accounts rather than a crash at start-up. A version 1 file
 * reads as version 2 (switch accounts ruling 3): every entry kept, the first signed-in one active. A version 2
 * file whose `active` names no signed-in entry (edited by hand) keeps its accounts, with the first signed-in
 * one active. Reading is pure; the file on disk becomes version 2 at the next save.
 */
export function parseAccountsFile(document: unknown): AccountsFile {
  const current = accountsFileShape.superRefine((file, ctx) => uniqueAccounts(file.servers, ctx)).safeParse(document);
  if (current.success)
    return activeIsSignedIn(current.data)
      ? current.data
      : { ...current.data, active: firstSignedIn(current.data.servers) };
  const v1 = accountsFileV1Schema.safeParse(document);
  if (!v1.success) return { version: ACCOUNTS_FILE_VERSION, active: null, servers: [] };
  return { version: ACCOUNTS_FILE_VERSION, active: firstSignedIn(v1.data.servers), servers: v1.data.servers };
}
