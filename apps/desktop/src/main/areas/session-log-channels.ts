import type { WebContents } from 'electron';
import { WirebenchError } from '@wirebench/engine';
import { channels } from '../../shared/ipc.js';
import { registerHandler } from '../ipc/register.js';
import type { SessionLogStore, SessionLogSwitches } from '../session-logs.js';

/**
 * The `sessionLog.*` channels (#414), registered with the SSH area only. Each acts on the calling window's
 * open workspace; the renderer names a host and a log by id, and main finds the files.
 */
export function registerSessionLogChannels(deps: {
  logs: Pick<SessionLogStore, 'list' | 'read' | 'search' | 'remove' | 'pathOf'>;
  switches: Pick<SessionLogSwitches, 'all' | 'set'>;
  /** The calling window's open workspace. */
  workspaceOf: (sender: WebContents) => string | undefined;
  /** `shell.showItemInFolder`. */
  reveal: (path: string) => void;
}): void {
  const workspace = (sender: WebContents): string => {
    const id = deps.workspaceOf(sender);
    if (id === undefined) throw new WirebenchError('workspace-not-open', 'Open a workspace first');
    return id;
  };
  registerHandler(channels.sessionLog.switches, async (_request, sender) => ({
    switches: { ...(await deps.switches.all(workspace(sender))) },
  }));
  registerHandler(channels.sessionLog.setSwitch, async (request, sender) => {
    await deps.switches.set(workspace(sender), request.target, request.on);
    return {};
  });
  registerHandler(channels.sessionLog.list, async (request, sender) => ({
    logs: (await deps.logs.list(workspace(sender), request.hostId)).map((entry) => ({
      id: entry.id,
      hostId: entry.hostId,
      hostName: entry.hostName,
      address: entry.address,
      port: entry.port,
      user: entry.user,
      startedAt: entry.startedAt,
      ...(entry.endedAt === undefined ? {} : { endedAt: entry.endedAt }),
      ...(entry.exitCode === undefined ? {} : { exitCode: entry.exitCode }),
      ...(entry.signal === undefined ? {} : { signal: entry.signal }),
      ...(entry.reason === undefined ? {} : { reason: entry.reason }),
      raw: entry.raw,
      bytes: entry.bytes,
      live: entry.live,
    })),
  }));
  registerHandler(channels.sessionLog.read, (request, sender) =>
    deps.logs.read(workspace(sender), request.hostId, request.id),
  );
  registerHandler(channels.sessionLog.search, async (request, sender) => ({
    matches: await deps.logs.search(workspace(sender), request.hostId, request.query),
  }));
  registerHandler(channels.sessionLog.delete, async (request, sender) => {
    await deps.logs.remove(workspace(sender), request.hostId, request.id);
    return {};
  });
  registerHandler(channels.sessionLog.reveal, async (request, sender) => {
    deps.reveal(await deps.logs.pathOf(workspace(sender), request.hostId, request.id));
    return {};
  });
}
