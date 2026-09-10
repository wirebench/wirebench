import { ipcMain } from 'electron';
import type { IpcMainInvokeEvent, WebContents } from 'electron';
import type { z } from 'zod';
import type { ChannelRequest, ChannelResponse, IpcChannel } from '../../shared/ipc.js';
import { wrapHandler } from './envelope.js';

/**
 * Binds `handler` to `channel` via `ipcMain.handle`. Every call is validated against the
 * channel's request/response schemas and wrapped in the `{ok, value} | {ok, error}`
 * envelope (see {@link wrapHandler}) before crossing the context bridge.
 *
 * `handler` also receives the invoking `IpcMainInvokeEvent`'s `sender`, so handlers that
 * need to emit events back to the caller (e.g. import progress) do not need their own
 * `ipcMain` plumbing.
 */
export function registerHandler<Req extends z.ZodType, Res extends z.ZodType>(
  channel: IpcChannel<Req, Res>,
  handler: (
    request: ChannelRequest<IpcChannel<Req, Res>>,
    sender: WebContents,
  ) => Promise<ChannelResponse<IpcChannel<Req, Res>>>,
): void {
  ipcMain.handle(channel.name, async (event: IpcMainInvokeEvent, raw: unknown) => {
    const wrapped = wrapHandler(channel, (request) => handler(request, event.sender));
    return wrapped(raw);
  });
}
