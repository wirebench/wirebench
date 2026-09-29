/** The ci-tokens module's problems (callback-assertion spec §3). None of them ever carries the token. */
import type { WirebenchError } from '@wirebench/engine';
import { problem } from '../problem.js';

export const ciTokenForbidden = (): WirebenchError =>
  problem('ci-token-forbidden', 'A CI token may only read the webhook captures of its own workspace.', 403);
export const ciTokenRequired = (): WirebenchError => problem('ci-token-required', 'Only a CI token can ask this.', 403);
export const ciTokenNotFound = (): WirebenchError => problem('ci-token-not-found', 'That CI token was not found.', 404);
export const ciTokenNameTaken = (name: string): WirebenchError =>
  problem('ci-token-name-taken', `A CI token named "${name}" already exists in this workspace.`, 409);
export const ciTokenNameBlank = (): WirebenchError => problem('invalid-request', 'A CI token needs a name.', 400);
