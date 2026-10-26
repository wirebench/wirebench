import { channels } from '../../shared/ipc.js';
import { registerHandler, type HandlerTable } from '../ipc/register.js';
import type { TerminalShareOwner } from '../terminal-share/owner.js';
import type { TerminalShareViewer } from '../terminal-share/viewer.js';

/**
 * The `terminalShare.*` channels (#429), registered with the SSH area only. The owner's side acts on an SSH
 * session the calling window owns; the viewer's on a view the calling window joined.
 */
export function registerTerminalShareChannels(
  table: HandlerTable,
  deps: {
    readonly owner: Pick<
      TerminalShareOwner,
      'available' | 'start' | 'stop' | 'grant' | 'decline' | 'remove' | 'takeBack'
    >;
    readonly viewer: Pick<TerminalShareViewer, 'preview' | 'join' | 'leave' | 'input' | 'requestControl' | 'release'>;
  },
): void {
  const done = (): Promise<Record<string, never>> => Promise.resolve({});
  registerHandler(table, channels.terminalShare.available, async (_request, sender) => ({
    available: await deps.owner.available(sender),
  }));
  registerHandler(table, channels.terminalShare.start, (request, sender) => deps.owner.start(sender, request));
  registerHandler(table, channels.terminalShare.stop, (request, sender) => {
    deps.owner.stop(sender, request.sessionId);
    return done();
  });
  registerHandler(table, channels.terminalShare.grant, (request, sender) => {
    deps.owner.grant(sender, request.sessionId, request.userId);
    return done();
  });
  registerHandler(table, channels.terminalShare.decline, (request, sender) => {
    deps.owner.decline(sender, request.sessionId, request.userId);
    return done();
  });
  registerHandler(table, channels.terminalShare.remove, (request, sender) => {
    deps.owner.remove(sender, request.sessionId, request.userId);
    return done();
  });
  registerHandler(table, channels.terminalShare.takeBack, (request, sender) => {
    deps.owner.takeBack(sender, request.sessionId);
    return done();
  });
  registerHandler(table, channels.terminalShare.preview, (request) => deps.viewer.preview(request.link));
  registerHandler(table, channels.terminalShare.join, (request, sender) => deps.viewer.join(sender, request));
  registerHandler(table, channels.terminalShare.leave, (request, sender) => {
    deps.viewer.leave(sender, request.viewId);
    return done();
  });
  registerHandler(table, channels.terminalShare.input, (request, sender) => {
    deps.viewer.input(sender, request.viewId, request.data);
    return done();
  });
  registerHandler(table, channels.terminalShare.requestControl, (request, sender) => {
    deps.viewer.requestControl(sender, request.viewId);
    return done();
  });
  registerHandler(table, channels.terminalShare.release, (request, sender) => {
    deps.viewer.release(sender, request.viewId);
    return done();
  });
}
