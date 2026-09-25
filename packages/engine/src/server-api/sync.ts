/**
 * The server-sync module's wire shapes (server-sync spec §3.2, §4.4). The server's routes validate
 * with them (through `jsonSchema()`) and the desktop's `ServerClient` parses answers with them, so a
 * drift between the two fails typecheck.
 *
 * Plain zod only, with no refine or transform: the routes render these as draft-07 JSON Schema,
 * which can carry neither. The rules JSON Schema cannot express run in the handler (and, for
 * paths, in the client too):
 * - tree paths (`assertTreePath`);
 * - base64 and UTF-8 validity;
 * - the per-file limit of {@link MAX_SYNC_FILE_BYTES}.
 */
import { z } from 'zod';
import { MAX_TREE_PATH_LENGTH } from '../sync/tree-paths.js';
import { workspaceRoleSchema } from './teams.js';

/**
 * A full git object id: 40 hex (SHA-1) or 64 hex (SHA-256), lower case. Every commit id in a query
 * or a body matches this before it reaches git, so nothing a client sends can become a git option
 * (`--upload-pack=…`) or a revision expression (`HEAD~1`, `main`).
 */
export const SYNC_COMMIT_ID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
/** The largest single file a snapshot, a change list or a push may carry, decoded (§3.2). */
export const MAX_SYNC_FILE_BYTES = 8 * 1024 * 1024;
/** The most entries one `GET …/sync/log` returns (§3.2). */
export const MAX_SYNC_LOG_LIMIT = 200;
/** The longest commit subject a push may carry. */
export const MAX_SYNC_SUBJECT_LENGTH = 1000;

export const syncCommitIdSchema = z.string().regex(SYNC_COMMIT_ID_PATTERN);

/** `utf8`: the content is the text itself. `base64`: the content is the bytes, for anything not valid UTF-8. */
export const syncEncodingSchema = z.enum(['utf8', 'base64']);
export type SyncEncoding = z.infer<typeof syncEncodingSchema>;

/** A tree path on the wire. Its rules beyond length are `assertTreePath`'s, run in the handler and the client. */
const syncPathSchema = z.string().min(1).max(MAX_TREE_PATH_LENGTH);

/** One file of a tree. */
export const syncFileSchema = z.object({
  path: syncPathSchema,
  encoding: syncEncodingSchema,
  content: z.string(),
});
export type SyncFile = z.infer<typeof syncFileSchema>;

/** One path that differs; `content: null` means the file was deleted. */
export const syncChangeSchema = z.object({
  path: syncPathSchema,
  encoding: syncEncodingSchema,
  content: z.string().nullable(),
});
export type SyncChange = z.infer<typeof syncChangeSchema>;

// ---- head --------------------------------------------------------------------------------

/** `GET …/sync/head?from=`: `from` is the client's base, to count how far behind it is. */
export const syncHeadQuerySchema = z.object({ from: syncCommitIdSchema.optional() });
export type SyncHeadQuery = z.infer<typeof syncHeadQuerySchema>;
export const syncHeadResponseSchema = z.object({
  /** `refs/heads/main`, or `null` before the first push: an empty workspace. */
  head: syncCommitIdSchema.nullable(),
  /** Commits on `main` in total. */
  commits: z.number().int().min(0),
  /** Commits after the request's `from`, when it named one (§3.2). */
  behind: z.number().int().min(0).optional(),
  /** The caller's role, so the client refreshes it on every fetch. */
  role: workspaceRoleSchema,
});
export type SyncHeadResponse = z.infer<typeof syncHeadResponseSchema>;

// ---- snapshot ----------------------------------------------------------------------------

/** `GET …/sync/snapshot?at=`: `at` defaults to the head. */
export const syncSnapshotQuerySchema = z.object({ at: syncCommitIdSchema.optional() });
export type SyncSnapshotQuery = z.infer<typeof syncSnapshotQuerySchema>;
export const syncSnapshotResponseSchema = z.object({
  head: syncCommitIdSchema.nullable(),
  files: z.array(syncFileSchema),
});
export type SyncSnapshotResponse = z.infer<typeof syncSnapshotResponseSchema>;

// ---- changes -----------------------------------------------------------------------------

/** `GET …/sync/changes?from=&to=`: an absent `from` means the empty tree. */
export const syncChangesQuerySchema = z.object({
  from: syncCommitIdSchema.optional(),
  to: syncCommitIdSchema,
});
export type SyncChangesQuery = z.infer<typeof syncChangesQuerySchema>;
export const syncChangesResponseSchema = z.object({
  from: syncCommitIdSchema.nullable(),
  to: syncCommitIdSchema,
  files: z.array(syncChangeSchema),
});
export type SyncChangesResponse = z.infer<typeof syncChangesResponseSchema>;

// ---- commits (push) ----------------------------------------------------------------------

/** One pending commit. The server authors it as the caller; `at` becomes the author date. */
export const syncPushCommitSchema = z.object({
  subject: z.string().min(1).max(MAX_SYNC_SUBJECT_LENGTH),
  /** ISO 8601 with `Z` or an offset (`toISOString()` gives `Z`). It renders as JSON Schema `format: date-time`. */
  at: z.iso.datetime({ offset: true }),
  changes: z.array(syncChangeSchema),
});
export type SyncPushCommit = z.infer<typeof syncPushCommitSchema>;
/** `POST …/sync/commits`: `parent` must be the current head (`null` for an empty workspace), or the push is rejected. */
export const syncPushRequestSchema = z.object({
  parent: syncCommitIdSchema.nullable(),
  commits: z.array(syncPushCommitSchema).min(1),
});
export type SyncPushRequest = z.infer<typeof syncPushRequestSchema>;
/** `201`: the new head, and one id per pushed commit, in order. */
export const syncPushResponseSchema = z.object({
  head: syncCommitIdSchema,
  ids: z.array(syncCommitIdSchema),
});
export type SyncPushResponse = z.infer<typeof syncPushResponseSchema>;

// ---- log ---------------------------------------------------------------------------------

/** `GET …/sync/log?limit=`. Fastify's Ajv coerces the querystring, so the handler reads a number. */
export const syncLogQuerySchema = z.object({
  limit: z.number().int().min(1).max(MAX_SYNC_LOG_LIMIT).optional(),
});
export type SyncLogQuery = z.infer<typeof syncLogQuerySchema>;
/**
 * One commit, newest first. `author` is `Name <email>`. `at` is git's strict ISO author date,
 * passed on as is: its UTC spelling differs between git versions, so it is not checked as a format.
 */
export const syncLogEntrySchema = z.object({
  id: syncCommitIdSchema,
  subject: z.string(),
  author: z.string(),
  at: z.string(),
});
export type SyncLogEntry = z.infer<typeof syncLogEntrySchema>;
export const syncLogResponseSchema = z.array(syncLogEntrySchema);
