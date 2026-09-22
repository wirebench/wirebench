import { channels } from '../../shared/ipc.js';
import type { SecretScanSessions } from '../secret-scan-session.js';
import { registerHandler } from './register.js';

/**
 * Registers the `secretScan.*` IPC channels against the open projects' scan sessions.
 *
 * Each call names its project. `scan` answers with masked previews only, and `move` takes finding
 * ids and names — the values are read, stored and written back in main, so none crosses the bridge
 * (the response schemas are strict, so one that tried would fail validation instead).
 */
export function registerSecretScanChannels(sessions: Pick<SecretScanSessions, 'session'>): void {
  registerHandler(channels.secretScan.scan, async (request) => await sessions.session(request.projectId).review());

  registerHandler(channels.secretScan.keep, (request) => {
    sessions.session(request.projectId).keep(request.ids);
    return Promise.resolve({});
  });

  registerHandler(
    channels.secretScan.move,
    async (request) => await sessions.session(request.projectId).move(request.items),
  );
}
