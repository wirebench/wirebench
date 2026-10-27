import type { Caller } from '../host/platform.js';
import { channels } from '@wirebench/wire/ipc';
import type { SecretScanSessions } from '../secret-scan-session.js';
import { registerHandler, type HandlerTable } from './register.js';

/**
 * Registers the `secretScan.*` IPC channels against the open projects' scan sessions.
 *
 * Each call names its project. `scan` answers with masked previews only, and `move` takes finding
 * ids and names — the values are read, stored and written back in main, so none crosses the bridge
 * (the response schemas are strict, so one that tried would fail validation instead).
 *
 * `tokens` lists the project's `${secret:name}` names and whether each has a value here; `setValue`
 * stores one the user typed. That value crosses once, renderer to main, and no response carries it.
 *
 * `hold` suspends autosave for the projects a review is open on until `release`. A renderer that
 * goes away mid-review — its window closed, its process crashed, the page reloaded — never sends
 * that `release`, so its holds are dropped then instead: autosave cannot stay off for good.
 */
export function registerSecretScanChannels(
  table: HandlerTable,
  sessions: Pick<SecretScanSessions, 'session' | 'hold' | 'release' | 'releaseOwner'>,
): void {
  registerHandler(
    table,
    channels.secretScan.scan,
    async (request) => await sessions.session(request.projectId).review(),
  );

  registerHandler(table, channels.secretScan.keep, (request) => {
    sessions.session(request.projectId).keep(request.ids);
    return Promise.resolve({});
  });

  registerHandler(
    table,
    channels.secretScan.move,
    async (request) => await sessions.session(request.projectId).move(request.items),
  );

  registerHandler(table, channels.secretScan.tokens, async (request) => ({
    tokens: await sessions.session(request.projectId).tokens(),
  }));

  registerHandler(
    table,
    channels.secretScan.setValue,
    async (request) => await sessions.session(request.projectId).setValue(request.name, request.value),
  );

  /** The renderers already watched for going away, so each gets its listeners once. */
  const watched = new WeakSet<Caller>();
  registerHandler(table, channels.secretScan.hold, (request, sender) => {
    if (!watched.has(sender)) {
      watched.add(sender);
      const drop = (): void => {
        sessions.releaseOwner(sender.id);
      };
      sender.onClosed(drop);
      // A crash, a reload (or any main-frame navigation) starts a renderer that knows nothing of the old holds.
      sender.onReset(drop, { on: 'commit' });
    }
    return Promise.resolve({ holdId: sessions.hold(request.projectIds, sender.id) });
  });

  registerHandler(table, channels.secretScan.release, (request) => {
    sessions.release(request.holdId);
    return Promise.resolve({});
  });
}
