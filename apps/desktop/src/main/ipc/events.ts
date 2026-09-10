import type { WebContents } from 'electron';
import type { z } from 'zod';
import type { IpcEvent } from '../../shared/ipc.js';
import { validateEventPayload } from './envelope.js';

/**
 * Validates `payload` against `event`'s schema (see {@link validateEventPayload}) and sends
 * it to `target`. Throws if the payload doesn't match the schema — a mismatch here is a
 * programming error in main-process code, not untrusted input, so it is not caught.
 */
export function emitEvent<Payload extends z.ZodType>(
  target: WebContents,
  event: IpcEvent<Payload>,
  payload: z.infer<Payload>,
): void {
  const parsed = validateEventPayload(event, payload);
  if (target.isDestroyed()) return;
  target.send(event.name, parsed);
}
