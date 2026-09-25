/**
 * Every `sync-*` problem (spec §3.2, §3.5, §10), one function each so a code is spelled once.
 * Clients see `{ code, message }` only (host spec §3.3); the desktop maps these codes in §3.5.
 */
import { MAX_SYNC_FILE_BYTES, type WirebenchError } from '@wirebench/engine';
import { problem } from '../problem.js';

/** R3: no head in the body. `toProblem` drops details anyway; the client's retry fetches the head. */
export function syncPushRejected(): WirebenchError {
  return problem('sync-push-rejected', 'Someone else pushed first. Pull, then push again.', 409);
}

export function syncUnknownCommit(): WirebenchError {
  return problem('sync-unknown-commit', 'This workspace has no such commit on the server.', 404);
}

export function syncNotAncestor(): WirebenchError {
  return problem('sync-not-ancestor', 'The starting commit is not an ancestor of the end commit.', 400);
}

/** R5: one operator setting bounds pushes and reads; the message names it so the app can show it. */
export function syncTooLarge(limitMb: number): WirebenchError {
  return problem(
    'sync-too-large',
    `This is larger than the server's ${limitMb} MiB limit. An operator can raise WIREBENCH_SERVER_BODY_LIMIT_MB.`,
    413,
  );
}

/** §3.2: the engine's tree-path rules, applied in the handler before any git call. */
export function syncPathRefused(path: string): WirebenchError {
  return problem('sync-path-refused', `"${path}" is not a workspace file that can be synced.`, 400);
}

/** §3.2: base64 that does not decode, UTF-8 that is not well formed, or a file over the per-file limit. */
export function syncContentInvalid(path: string): WirebenchError {
  const limitMb = MAX_SYNC_FILE_BYTES / (1024 * 1024);
  return problem(
    'invalid-request',
    `The content of "${path}" is not valid base64 or UTF-8, or is larger than ${limitMb} MiB.`,
    400,
  );
}

/**
 * A commit subject with a control character (U+0000 to U+001F, U+007F). NUL cannot reach git as an
 * argument at all, and a newline would turn the subject into a message body; the store does not check.
 */
export function syncSubjectInvalid(): WirebenchError {
  return problem('invalid-request', 'A commit subject cannot contain control characters or line breaks.', 400);
}
