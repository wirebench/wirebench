import { isWirebenchError } from '@wirebench/engine';
import type { z } from 'zod';
import type { ChannelRequest, ChannelResponse, IpcChannel, IpcError, IpcResult } from '../../shared/ipc.js';

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
 * Maps any thrown value to the wire-safe {@link IpcError} shape. A {@link WirebenchError}
 * (or subclass) keeps its own `code`/`message`/`details`; anything else becomes a generic
 * `internal-error` so no unexpected error detail (e.g. stack traces) leaks to the renderer.
 */
export function toIpcError(err: unknown): IpcError {
  if (isWirebenchError(err)) {
    return { code: err.code, message: err.message, details: err.details };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { code: 'internal-error', message };
}

/**
 * Runs `handler` against a validated request and wraps the outcome as an {@link IpcResult}:
 * request validation failure, a thrown error, or a validated success value. Pure — no
 * `electron` import — so `register.ts` only needs to bind this to `ipcMain.handle`.
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
      return { ok: true, value: channel.response.parse(result) as ChannelResponse<IpcChannel<Req, Res>> };
    } catch (err) {
      return { ok: false, error: toIpcError(err) };
    }
  };
}
