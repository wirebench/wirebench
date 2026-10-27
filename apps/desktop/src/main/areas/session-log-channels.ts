import type { Caller } from '../host/platform.js';
import { WirebenchError } from '@wirebench/engine';
import { channels } from '@wirebench/wire/ipc';
import { registerHandler, type HandlerTable } from '../ipc/register.js';
import type { ServerClient } from '../server-client.js';
import { withToken } from '../server-token.js';
import type { TokenSource } from '../server-token.js';
import type { SessionLogStore, SessionLogSwitches } from '../session-logs.js';

/** What the team session-log channels need (#430): the window's server binding and a signed-in account. */
export interface TeamSessionLogDeps {
  /** The calling window's workspace on its server; `undefined` when it is not shared to one. */
  readonly serverOf: (sender: Caller) => { readonly url: string; readonly workspaceId: string } | undefined;
  readonly client: Pick<ServerClient, 'listSessionLogs' | 'readSessionLog'>;
  readonly accounts: TokenSource;
}

/**
 * The `sessionLog.*` channels (#414), registered with the SSH area only. Each acts on the calling window's
 * open workspace; the renderer names a host and a log by id, and main finds the files.
 */
export function registerSessionLogChannels(
  table: HandlerTable,
  deps: {
    logs: Pick<SessionLogStore, 'list' | 'read' | 'search' | 'remove' | 'pathOf'>;
    switches: Pick<SessionLogSwitches, 'all' | 'set'>;
    /** The calling window's open workspace. */
    workspaceOf: (sender: Caller) => string | undefined;
    /** Whether the calling window's workspace server records every SSH session (#430), whatever the switches say. */
    teamRecords?: (sender: Caller) => boolean;
    /** `shell.showItemInFolder`. */
    reveal: (path: string) => void;
    /** The server's logs (#430); without it the team channels answer that there are none. */
    team?: TeamSessionLogDeps;
  },
): void {
  const workspace = (sender: Caller): string => {
    const id = deps.workspaceOf(sender);
    if (id === undefined) throw new WirebenchError('workspace-not-open', 'Open a workspace first');
    return id;
  };
  registerHandler(table, channels.sessionLog.switches, async (_request, sender) => ({
    switches: { ...(await deps.switches.all(workspace(sender))) },
    team: deps.teamRecords?.(sender) ?? false,
  }));
  registerHandler(table, channels.sessionLog.setSwitch, async (request, sender) => {
    await deps.switches.set(workspace(sender), request.target, request.on);
    return {};
  });
  registerHandler(table, channels.sessionLog.list, async (request, sender) => ({
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
  registerHandler(table, channels.sessionLog.read, (request, sender) =>
    deps.logs.read(workspace(sender), request.hostId, request.id),
  );
  registerHandler(table, channels.sessionLog.search, async (request, sender) => ({
    matches: await deps.logs.search(workspace(sender), request.hostId, request.query),
  }));
  registerHandler(table, channels.sessionLog.delete, async (request, sender) => {
    await deps.logs.remove(workspace(sender), request.hostId, request.id);
    return {};
  });
  registerHandler(table, channels.sessionLog.reveal, async (request, sender) => {
    deps.reveal(await deps.logs.pathOf(workspace(sender), request.hostId, request.id));
    return {};
  });
  registerHandler(table, channels.sessionLog.teamList, async (request, sender) => {
    const server = deps.team?.serverOf(sender);
    if (!deps.team || !server) return { available: false, logs: [], next: null };
    const team = deps.team;
    const page = await withToken(team, server.url, (origin, token) =>
      team.client.listSessionLogs(origin, token, server.workspaceId, {
        ...(request.hostId !== undefined ? { hostId: request.hostId } : {}),
        ...(request.userId !== undefined ? { userId: request.userId } : {}),
        ...(request.before !== undefined ? { before: request.before } : {}),
      }),
    );
    return {
      available: true,
      next: page.next,
      logs: page.logs.map((log) => ({
        id: log.id,
        userId: log.userId,
        userName: log.userName,
        hostId: log.hostId,
        hostName: log.hostName,
        address: log.address,
        port: log.port,
        user: log.user,
        startedAt: log.startedAt,
        endedAt: log.endedAt,
        exitCode: log.exitCode,
        reason: log.reason,
        size: log.size,
        truncated: log.truncated,
        live: log.live,
      })),
    };
  });
  registerHandler(table, channels.sessionLog.teamRead, async (request, sender) => {
    const server = deps.team?.serverOf(sender);
    if (!deps.team || !server)
      throw new WirebenchError('workspace-not-shared', 'This workspace is not shared to a server');
    const team = deps.team;
    const answer = await withToken(team, server.url, (origin, token) =>
      team.client.readSessionLog(origin, token, server.workspaceId, request.id, request.offset ?? 0),
    );
    return { text: answer.text, next: answer.next, size: answer.size, truncated: answer.truncated, live: answer.live };
  });
}
