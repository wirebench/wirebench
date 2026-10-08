import { ipcMain } from 'electron';
import type { IpcMainInvokeEvent, WebContents } from 'electron';
import type { z } from 'zod';
import type { ChannelRequest, ChannelResponse, IpcChannel } from '../../shared/ipc.js';
import { runAsCaller } from '../window-scope.js';
import { wrapHandler } from './envelope.js';

/**
 * Binds `handler` to `channel` via `ipcMain.handle`. Every call is validated against the
 * channel's request/response schemas and wrapped in the `{ok, value} | {ok, error}`
 * envelope (see {@link wrapHandler}) before crossing the context bridge.
 *
 * `handler` also receives the invoking `IpcMainInvokeEvent`'s `sender`, so handlers that
 * need to emit events back to the caller (e.g. import progress) do not need their own
 * `ipcMain` plumbing.
 *
 * The handler runs as a call from the sender's window (`window-scope.ts`), so the per-window
 * services it reaches through main's routers are that window's.
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
    // Tests hand in a bare event; a real one always has its sender.
    const sender = event.sender as WebContents | undefined;
    return sender === undefined ? wrapped(raw) : runAsCaller(sender.id, () => wrapped(raw));
  });
}
