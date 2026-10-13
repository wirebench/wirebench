/** The scheduled-runs module's problems (scheduled-runs spec §3.7). None of them ever carries a secret or a URL. */
import { SCHEDULE_LIMITS, type WirebenchError } from '@wirebench/engine';
import { problem } from '../problem.js';

export const scheduleNotFound = (): WirebenchError =>
  problem('schedules-not-found', 'That schedule was not found.', 404);
export const scheduleNameTaken = (name: string): WirebenchError =>
  problem('schedules-name-taken', `A schedule named "${name}" already exists in this workspace.`, 409);
export const cronInvalid = (reason: string): WirebenchError =>
  problem('schedules-cron-invalid', `The schedule is not one this server can run: ${reason}.`, 400);
export const zoneInvalid = (zone: string): WirebenchError =>
  problem('schedules-zone-invalid', `"${zone}" is not a time zone this server knows.`, 400);
export const alertHostRefused = (host: string): WirebenchError =>
  problem('schedules-alert-host-refused', `Alerts may not be sent to ${host} on this server.`, 400);
export const smtpMissing = (): WirebenchError =>
  problem('schedules-smtp-missing', 'This server has no mail settings, so it cannot send email alerts.', 400);
export const secretKeyMissing = (): WirebenchError =>
  problem(
    'schedules-secret-key-missing',
    'This server has no WIREBENCH_SERVER_SCHEDULES_SECRET_KEY, so it cannot keep secrets or alert URLs.',
    409,
  );
export const scheduleLimit = (): WirebenchError =>
  problem('schedules-limit', `A workspace may have at most ${SCHEDULE_LIMITS.maxPerWorkspace} schedules.`, 409);
export const runNotFound = (): WirebenchError => problem('schedules-run-not-found', 'That run was not found.', 404);
export const runFinished = (): WirebenchError =>
  problem('schedules-run-finished', 'That run has already finished.', 409);
export const runOpen = (): WirebenchError =>
  problem('schedules-run-open', 'A run of this schedule is still queued or running.', 409);
export const cursorInvalid = (): WirebenchError =>
  problem('schedules-cursor-invalid', 'That page cursor is not one this server gave out.', 400);
