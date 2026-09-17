import { isWirebenchError, WirebenchError } from '@wirebench/engine';
import type { z } from 'zod';
import type { ChannelRequest, ChannelResponse, IpcChannel, IpcError, IpcEvent, IpcResult } from '../../shared/ipc.js';

/**
 * Validates a raw IPC payload against a channel's request schema.
 * Returns the parsed value, or `undefined` when validation fails (with the zod issues
 * available on the returned `error` field for callers that need them).
 */
export function parseRequest<Req extends z.ZodType, Res extends z.ZodType>(
  channel: IpcChannel<Req, Res>,
  raw: unknown,
): { readonly ok: true; readonly value: z.infer<Req> } | { readonly ok: false; readonly error: IpcError } {
  const parsed = channel.request.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      error: {
        code: 'ipc-invalid-request',
        message: `Invalid request payload for channel "${channel.name}"`,
        details: { issues: parsed.error.issues },
      },
    };
  }
  return { ok: true, value: parsed.data };
}

/**
 * An error's details without the unredacted request a transport error carries (`failedRequestOf`):
 * main redacts that request into the HTTP Log's failure row, and the raw copy must never reach the
 * renderer through an error result.
 */
function wireSafeDetails(details: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(details).filter(([key]) => key !== 'request'));
}

/**
 * Maps any thrown value to the wire-safe {@link IpcError} shape. A {@link WirebenchError}
 * (or subclass) keeps its own `code`/`message`/`details`; anything else becomes a generic
 * `internal-error` so no unexpected error detail (e.g. stack traces) leaks to the renderer.
 */
export function toIpcError(err: unknown): IpcError {
  if (isWirebenchError(err)) {
    return {
      code: err.code,
      message: err.message,
      ...(err.details !== undefined ? { details: wireSafeDetails(err.details) } : {}),
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { code: 'internal-error', message };
}

/**
 * Runs `handler` against a validated request and wraps the outcome as an {@link IpcResult}:
 * request validation failure, a thrown error, an invalid handler result, or a validated
 * success value. Pure — no `electron` import — so `register.ts` only needs to bind this to
 * `ipcMain.handle`.
 */
export function wrapHandler<Req extends z.ZodType, Res extends z.ZodType>(
  channel: IpcChannel<Req, Res>,
  handler: (request: ChannelRequest<IpcChannel<Req, Res>>) => Promise<ChannelResponse<IpcChannel<Req, Res>>>,
): (raw: unknown) => Promise<IpcResult<ChannelResponse<IpcChannel<Req, Res>>>> {
  return async (raw: unknown) => {
    const parsed = parseRequest(channel, raw);
    if (!parsed.ok) {
      return parsed;
    }
    try {
      const result = await handler(parsed.value as ChannelRequest<IpcChannel<Req, Res>>);
      const parsedResponse = channel.response.safeParse(result);
      if (!parsedResponse.success) {
        return {
          ok: false,
          error: {
            code: 'ipc-invalid-response',
            message: 'Handler returned a value that does not match the response schema',
            details: { issues: parsedResponse.error.issues },
          },
        };
      }
      return { ok: true, value: parsedResponse.data as ChannelResponse<IpcChannel<Req, Res>> };
    } catch (err) {
      return { ok: false, error: toIpcError(err) };
    }
  };
}

/**
 * Validates an outgoing main-to-renderer event payload against its schema before it is sent.
 * A mismatch here is a programming error (the payload was constructed by main-process code,
 * not by untrusted input), so it throws a {@link WirebenchError} rather than returning a
 * result — callers (see `events.ts`) let it propagate.
 */
export function validateEventPayload<Payload extends z.ZodType>(
  event: IpcEvent<Payload>,
  payload: unknown,
): z.infer<Payload> {
  const parsed = event.payload.safeParse(payload);
  if (!parsed.success) {
    throw new WirebenchError('ipc-invalid-event', `Invalid event payload for event "${event.name}"`, {
      details: { issues: parsed.error.issues },
    });
  }
  return parsed.data;
}
