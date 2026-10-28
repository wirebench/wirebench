/**
 * One call from a connection, served against a host's {@link HandlerTable}: what a transport other
 * than Electron's IPC (the server's WebSocket) does per frame. It runs the handler as a call from
 * the caller, as `bindIpc` does on the desktop, so an embedder never needs `@wirebench/host/desktop`.
 */
import type { IpcResult } from '@wirebench/wire/ipc';
import { runAsCaller } from '../window-scope.js';
import type { Host } from './create-host.js';
import type { Caller } from './platform.js';

/** A call as it arrives: the caller's own id for the reply, the channel and its raw request. */
export interface CallFrame {
  readonly id: number;
  readonly channel: string;
  readonly request: unknown;
}

/** The answer to one {@link CallFrame}: its id and the handler's envelope. */
export type ReplyFrame = { readonly id: number } & IpcResult<unknown>;

/** The group a channel belongs to (`workspace` for `workspace.open`): what a refusal names as missing. */
function channelGroup(channel: string): string {
  const dot = channel.indexOf('.');
  return dot === -1 ? channel : channel.slice(0, dot);
}

/**
 * Serves `frame` for `caller`. A channel the host does not have, or one `allowed` refuses, answers
 * `host-capability-missing` naming the channel's group; nothing runs. Never rejects: a handler's own
 * failure is already in its envelope, and anything else becomes an `internal-error` reply.
 *
 * @param allowed the embedder's allowlist (the server's channel groups); absent, every registered channel
 */
export async function serveCall(
  host: Host,
  caller: Caller,
  frame: CallFrame,
  allowed?: (channel: string) => boolean,
): Promise<ReplyFrame> {
  try {
    const run = allowed === undefined || allowed(frame.channel) ? host.handlers.get(frame.channel) : undefined;
    if (run === undefined) {
      const capability = channelGroup(frame.channel);
      return {
        id: frame.id,
        ok: false,
        error: {
          code: 'host-capability-missing',
          message: `This host does not serve ${capability} calls`,
          details: { capability },
        },
      };
    }
    return { id: frame.id, ...(await runAsCaller(caller.id, () => run(frame.request, caller))) };
  } catch {
    // The table's handlers never throw (`wrapHandler`); an allowlist might. Either way the transport's
    // loop gets an answer, not a rejection.
    return { id: frame.id, ok: false, error: { code: 'internal-error', message: 'The call failed' } };
  }
}
