/**
 * The status names a request file's `status` assertion may be written with.
 *
 * In `assert/` because the assertion file schema (`schema.ts`) lists them, and core imports no
 * protocol folder (protocol modules spec §7.2). They are gRPC's; `grpc/status.ts` re-exports the
 * table and keeps everything else about a status.
 */

/** The seventeen status codes. `0` is the only success. */
export const GRPC_STATUS_NAMES: Readonly<Record<number, string>> = Object.freeze({
  0: 'OK',
  1: 'CANCELLED',
  2: 'UNKNOWN',
  3: 'INVALID_ARGUMENT',
  4: 'DEADLINE_EXCEEDED',
  5: 'NOT_FOUND',
  6: 'ALREADY_EXISTS',
  7: 'PERMISSION_DENIED',
  8: 'RESOURCE_EXHAUSTED',
  9: 'FAILED_PRECONDITION',
  10: 'ABORTED',
  11: 'OUT_OF_RANGE',
  12: 'UNIMPLEMENTED',
  13: 'INTERNAL',
  14: 'UNAVAILABLE',
  15: 'DATA_LOSS',
  16: 'UNAUTHENTICATED',
});
