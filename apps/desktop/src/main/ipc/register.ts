import type { z } from 'zod';
import type { ChannelRequest, ChannelResponse, IpcChannel, IpcResult } from '../../shared/ipc.js';
import type { Caller } from '../host/platform.js';
import { wrapHandler } from './envelope.js';

/**
 * Every registered channel's wrapped handler, by channel name. A table is made once by whoever
 * starts the host and passed to each `register*Channels` function; a transport (`bindIpc` for
 * Electron's `ipcMain`) then serves it. There is no shared table: nothing here holds state.
 */
export type HandlerTable = Map<string, (raw: unknown, caller: Caller) => Promise<IpcResult<unknown>>>;

/**
 * Records `handler` for `channel` in `table`. Every call is validated against the channel's
 * request/response schemas and wrapped in the `{ok, value} | {ok, error}` envelope (see
 * {@link wrapHandler}) before it crosses to the renderer.
 *
 * `handler` also receives the invoking {@link Caller}, so handlers that need to emit events back
 * to whoever asked (e.g. import progress) do not need their own transport plumbing.
 *
 * The transport runs the handler as a call from that caller (`window-scope.ts`), so the
 * per-window services it reaches through main's routers are that window's.
 */
export function registerHandler<Req extends z.ZodType, Res extends z.ZodType>(
  table: HandlerTable,
  channel: IpcChannel<Req, Res>,
  handler: (
    request: ChannelRequest<IpcChannel<Req, Res>>,
    caller: Caller,
  ) => Promise<ChannelResponse<IpcChannel<Req, Res>>>,
): void {
  // A second handler for a channel is a bug, as a second `ipcMain.handle` was: refuse it at startup.
  if (table.has(channel.name)) throw new Error(`Attempted to register a second handler for '${channel.name}'`);
  table.set(channel.name, (raw, caller) => wrapHandler(channel, (request) => handler(request, caller))(raw));
}
