/**
 * The Files tab's plain constants, free of zod: the renderer imports them eagerly, and a value import of
 * `sftp-wire.ts` would build zod schemas before `main.tsx` turns zod's JIT probe off (the renderer CSP
 * trap; `test/renderer-eager-imports.test.ts` guards it).
 */

/** Transfers running at once per window; the rest wait as `queued`. */
export const TRANSFER_CONCURRENCY = 3;

/** `sftp.transfer` progress events per transfer per second (state changes always go out). */
export const PROGRESS_EVENTS_PER_SECOND = 4;

/** Milliseconds an edited copy must be quiet before its save is uploaded. */
export const EDIT_DEBOUNCE_MS = 500;

/** Above this many bytes, editing a remote file asks first. */
export const EDIT_ASK_ABOVE_BYTES = 50 * 1024 * 1024;

/** A file being written is `<name>.wirebench-part` until its last byte lands, then renamed. */
export const PART_SUFFIX = '.wirebench-part';
