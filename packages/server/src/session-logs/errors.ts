/** Every `session-logs-*` problem (team session logs spec, Errors), one function each so a code is spelled once. */
import type { WirebenchError } from '@wirebench/engine';
import { problem } from '../problem.js';

export const recordingOff = (): WirebenchError =>
  problem('session-logs-recording-off', 'This workspace does not record SSH sessions.', 409);
/** The client reopens the log to learn the size the server holds, then sends from there. */
export const offsetMismatch = (): WirebenchError =>
  problem('session-logs-offset', 'The server holds a different amount of this log. Reopen it and resend.', 409);
export const logEnded = (): WirebenchError =>
  problem('session-logs-ended', 'This session log has ended and takes no more output.', 409);
/** A member writing to a log they did not open hears "not found", the same as for an unknown id. */
export const logNotFound = (): WirebenchError =>
  problem('session-logs-not-found', 'That session log does not exist in this workspace.', 404);
