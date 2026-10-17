/** The `terminal-share-*` problem codes (team sessions spec, Errors). */
import type { WirebenchError } from '@wirebench/engine';
import { problem } from '../problem.js';

/** No such share in this workspace, or the caller was removed from it: one answer, so an id reveals nothing. */
export function shareNotFound(): WirebenchError {
  return problem('terminal-share-not-found', 'That shared terminal has ended or does not exist.', 404);
}
