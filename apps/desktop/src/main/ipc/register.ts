import { ipcMain } from 'electron';
import type { z } from 'zod';
import type { ChannelRequest, ChannelResponse, IpcChannel } from '../../shared/ipc.js';
import { wrapHandler } from './envelope.js';

/**
 * Binds `handler` to `channel` via `ipcMain.handle`. Every call is validated against the
 * channel's request/response schemas and wrapped in the `{ok, value} | {ok, error}`
 * envelope (see {@link wrapHandler}) before crossing the context bridge.
 */
export function registerHandler<Req extends z.ZodType, Res extends z.ZodType>(
  channel: IpcChannel<Req, Res>,
  handler: (request: ChannelRequest<IpcChannel<Req, Res>>) => Promise<ChannelResponse<IpcChannel<Req, Res>>>,
): void {
  const wrapped = wrapHandler(channel, handler);
  ipcMain.handle(channel.name, async (_event, raw: unknown) => wrapped(raw));
}
