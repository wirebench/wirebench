/** Every `hooks-*` problem (webhook-capture spec §3.5), one function each so a code is spelled once. */
import type { WirebenchError } from '@wirebench/engine';
import { problem } from '../problem.js';

/** Also another workspace's catch URL: an id reveals nothing, as teams-access answers for a workspace. */
export const catchUrlNotFound = (): WirebenchError =>
  problem('hooks-not-found', 'That catch URL does not exist in this workspace.', 404);
export const captureNotFound = (): WirebenchError =>
  problem('hooks-capture-not-found', 'That capture does not exist; it may have been cleared or aged out.', 404);
export const catchUrlNameTaken = (): WirebenchError =>
  problem('hooks-name-taken', 'This workspace already has a catch URL with this name.', 409);
export const catchUrlNameInvalid = (): WirebenchError =>
  problem('hooks-name-invalid', 'Names are 1 to 100 characters, not counting spaces at either end.', 400);
export const catchUrlLimitReached = (limit: number): WirebenchError =>
  problem('hooks-limit-reached', `A workspace holds at most ${limit} catch URLs. Delete one first.`, 409);
export const responseBodyTooLarge = (): WirebenchError =>
  problem('hooks-response-too-large', 'A configured response body is at most 64 KiB.', 400);
export const cursorConflict = (): WirebenchError =>
  problem('hooks-cursor-conflict', 'Page with before or with after, not both.', 400);
export const signatureKeyUnset = (): WirebenchError =>
  problem(
    'hooks-signature-key-unset',
    'Signatures need WIREBENCH_SERVER_HOOKS_SECRET_KEY, which the server administrator has not set.',
    409,
  );
export const signatureSecretRequired = (): WirebenchError =>
  problem('hooks-signature-secret-required', 'Enter the secret the sender signs with.', 400);
/** Spec §6's `400 invalid`: the generic shape code, since the request is well-formed but contradictory. */
export const rejectNeedsSignature = (): WirebenchError =>
  problem('invalid-request', 'Reject unverified needs a signature scheme.', 400);
