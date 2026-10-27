/**
 * How an IPC channel and a main-to-renderer event are declared (kind modules spec §4.3). Kept apart
 * from `ipc.ts` so each kind's `kinds/<kind>/channels.ts` can declare its fragment without importing
 * the registry that composes it; `ipc.ts` re-exports every name.
 */
import type { z } from 'zod';

/**
 * A typed request/response contract for one `ipcMain.handle` / `ipcRenderer.invoke` pair.
 * Carries the channel name plus the zod schemas used to validate both directions, so main
 * and renderer share a single source of truth for the wire shape.
 */
export interface IpcChannel<Req extends z.ZodType, Res extends z.ZodType> {
  readonly name: string;
  readonly request: Req;
  readonly response: Res;
}

/**
 * Declares one IPC channel. The returned object is passed to both
 * `registerHandler` (main process) and the preload API builder so the request/response
 * shape only needs to be written once.
 */
export function defineChannel<Req extends z.ZodType, Res extends z.ZodType>(
  name: string,
  request: Req,
  response: Res,
): IpcChannel<Req, Res> {
  return { name, request, response };
}

/** The parsed request payload type for a given {@link IpcChannel}. */
export type ChannelRequest<C> = C extends IpcChannel<infer Req, z.ZodType> ? z.infer<Req> : never;

/** The parsed response payload type for a given {@link IpcChannel}. */
export type ChannelResponse<C> = C extends IpcChannel<z.ZodType, infer Res> ? z.infer<Res> : never;

/**
 * A typed, one-way, main-to-renderer event contract. Unlike {@link IpcChannel}, events have
 * no response and no request validation — only a payload schema for what main sends.
 */
export interface IpcEvent<Payload extends z.ZodType> {
  readonly name: string;
  readonly payload: Payload;
}

/** Declares one main-to-renderer event, validated with {@link Payload} on the sending side. */
export function defineEvent<Payload extends z.ZodType>(name: string, payload: Payload): IpcEvent<Payload> {
  return { name, payload };
}

/** The payload type for a given {@link IpcEvent}. */
export type EventPayload<E> = E extends IpcEvent<infer Payload> ? z.infer<Payload> : never;
