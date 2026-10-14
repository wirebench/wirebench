import { z } from 'zod';

/**
 * Wire shapes of the SSH area's Files tab (`sftp.*`). No request, answer or event carries a credential, a
 * key's bytes or any file content: transfer events carry names, sizes and states only. Renderer code imports
 * types from here, never a value (the renderer CSP trap; constants live in `sftp-defaults.ts`).
 */

/** This machine, or one of the window's own SFTP sessions. */
export const sftpPlaceWireSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('local') }),
  z.strictObject({ kind: z.literal('remote'), sessionId: z.string().min(1) }),
]);
export type SftpPlaceWire = z.infer<typeof sftpPlaceWireSchema>;

const pathSchema = z.string().min(1);
/** Permission bits only. */
const modeSchema = z.number().int().min(0).max(0o7777);

export const sftpEntryWireSchema = z.object({
  name: z.string(),
  type: z.enum(['file', 'dir', 'symlink', 'other']),
  size: z.number(),
  /** Milliseconds since the epoch. */
  mtime: z.number(),
  /** Remote only. */
  mode: modeSchema.optional(),
  /** For a symlink, what it points at; a dangling link is `other`. */
  targetType: z.enum(['file', 'dir', 'other']).optional(),
});
export type SftpEntryWire = z.infer<typeof sftpEntryWireSchema>;

/** A failure inside an event (a transfer or an edit), shaped like an IPC error. */
export const sftpErrorWireSchema = z.object({
  code: z.string(),
  message: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
});

/** `attemptId`: the connect's progress goes to the window as `ssh.connectProgress` under it (#528). */
export const sftpOpenRequestSchema = z.strictObject({
  hostId: z.string().min(1),
  attemptId: z.string().min(1).max(100).optional(),
});
/** `home` is the server's login directory, absolute. */
export const sftpOpenResponseSchema = z.object({ sessionId: z.string(), home: z.string() });
export const sftpCloseRequestSchema = z.strictObject({ sessionId: z.string().min(1) });

export const sftpListRequestSchema = z.strictObject({ place: sftpPlaceWireSchema, path: pathSchema });
/** `path` is the absolute path the server or the OS resolved. */
export const sftpListResponseSchema = z.object({ path: z.string(), entries: z.array(sftpEntryWireSchema) });
export const sftpMkdirRequestSchema = z.strictObject({ place: sftpPlaceWireSchema, path: pathSchema });
export const sftpRenameRequestSchema = z.strictObject({ place: sftpPlaceWireSchema, from: pathSchema, to: pathSchema });
export const sftpRemoveRequestSchema = z.strictObject({
  place: sftpPlaceWireSchema,
  paths: z.array(pathSchema).min(1),
  recursive: z.boolean(),
});
export const sftpChmodRequestSchema = z.strictObject({
  place: sftpPlaceWireSchema,
  path: pathSchema,
  mode: modeSchema,
});

export const sftpCopyRequestSchema = z.strictObject({
  batchId: z.string().min(1),
  from: z.strictObject({ place: sftpPlaceWireSchema, paths: z.array(pathSchema).min(1) }),
  to: z.strictObject({ place: sftpPlaceWireSchema, dir: pathSchema }),
});
export type SftpCopyRequest = z.infer<typeof sftpCopyRequestSchema>;
/** One transfer id per path, in order. */
export const sftpCopyResponseSchema = z.object({ transferIds: z.array(z.string()) });

export const conflictDecisionWireSchema = z.enum(['skip', 'keep-both', 'replace']);
export type ConflictDecisionWire = z.infer<typeof conflictDecisionWireSchema>;
export const sftpResolveRequestSchema = z.strictObject({
  batchId: z.string().min(1),
  decision: conflictDecisionWireSchema,
  applyToRest: z.boolean(),
});
/** `sftp.cancel` and `sftp.retry`. */
export const sftpTransferRequestSchema = z.strictObject({ transferId: z.string().min(1) });

export const sftpLocalHomeRequestSchema = z.strictObject({});
export const sftpLocalHomeResponseSchema = z.object({ home: z.string(), downloads: z.string() });

export const sftpEditRequestSchema = z.strictObject({
  sessionId: z.string().min(1),
  path: pathSchema,
  /** The user agreed to edit a file above `EDIT_ASK_ABOVE_BYTES`. */
  confirmedLarge: z.boolean().optional(),
});
export const sftpEditResponseSchema = z.object({ editId: z.string() });
export const sftpEndEditRequestSchema = z.strictObject({ editId: z.string().min(1) });
export const sftpEditReplyRequestSchema = z.strictObject({
  editId: z.string().min(1),
  decision: z.enum(['overwrite', 'keep-remote']),
});

export const transferStateWireSchema = z.enum([
  'queued',
  'waiting',
  'running',
  'done',
  'failed',
  'cancelled',
  'skipped',
]);
export type TransferStateWire = z.infer<typeof transferStateWireSchema>;

export const sftpTransferEventSchema = z.object({
  transferId: z.string(),
  batchId: z.string(),
  /** The file's path under the batch's target folder, `/`-separated (`site/css/a.css`). */
  name: z.string(),
  state: transferStateWireSchema,
  /** Bytes. */
  done: z.number(),
  total: z.number(),
  bytesPerSecond: z.number(),
  error: sftpErrorWireSchema.optional(),
});
const conflictSideSchema = z.object({ size: z.number(), mtime: z.number() });
export const sftpConflictEventSchema = z.object({
  batchId: z.string(),
  transferId: z.string(),
  /** As in `sftp.transfer`. */
  name: z.string(),
  existing: conflictSideSchema,
  incoming: conflictSideSchema,
  /** Clashes of the batch still to come after this one. */
  remaining: z.number(),
});
export const sftpClosedEventSchema = z.object({ sessionId: z.string() });
export const sftpEditEventSchema = z.object({
  editId: z.string(),
  state: z.enum(['watching', 'uploading', 'uploaded', 'remote-changed', 'failed']),
  error: sftpErrorWireSchema.optional(),
});

export type SftpOpenRequest = z.infer<typeof sftpOpenRequestSchema>;
export type SftpOpenResponse = z.infer<typeof sftpOpenResponseSchema>;
export type SftpCloseRequest = z.infer<typeof sftpCloseRequestSchema>;
export type SftpListRequest = z.infer<typeof sftpListRequestSchema>;
export type SftpListResponse = z.infer<typeof sftpListResponseSchema>;
export type SftpMkdirRequest = z.infer<typeof sftpMkdirRequestSchema>;
export type SftpRenameRequest = z.infer<typeof sftpRenameRequestSchema>;
export type SftpRemoveRequest = z.infer<typeof sftpRemoveRequestSchema>;
export type SftpChmodRequest = z.infer<typeof sftpChmodRequestSchema>;
export type SftpResolveRequest = z.infer<typeof sftpResolveRequestSchema>;
export type SftpLocalHomeResponse = z.infer<typeof sftpLocalHomeResponseSchema>;
export type SftpEditRequest = z.infer<typeof sftpEditRequestSchema>;
export type SftpEditReplyRequest = z.infer<typeof sftpEditReplyRequestSchema>;
export type SftpTransferEvent = z.infer<typeof sftpTransferEventSchema>;
export type SftpConflictEvent = z.infer<typeof sftpConflictEventSchema>;
export type SftpEditEvent = z.infer<typeof sftpEditEventSchema>;
