/**
 * Registers the `runner.*` IPC channels (#336): read and change a target's Runner settings, choose its
 * data file through main's own picker (the renderer never names a path), run it, stop it, and read
 * its past runs.
 */

import { channels } from '../../shared/ipc.js';
import type { RecordsReadPicks } from '../dialog-picks.js';
import { pickFile } from '../native-dialogs.js';
import type { RunnerService } from '../runner/runner-service.js';
import { registerHandler } from './register.js';

export function registerRunnerChannels(runner: RunnerService, picks: RecordsReadPicks): void {
  registerHandler(channels.runner.state, (request) => runner.state(request.targetId));
  registerHandler(channels.runner.settings.set, async (request) => {
    await runner.setSettings(request.targetId, request.settings);
    return { ok: true as const };
  });
  registerHandler(channels.runner.data.choose, (request, sender) =>
    runner.chooseData(request.targetId, () =>
      pickFile(sender, picks, {
        title: 'Choose a data file',
        filters: [{ name: 'Data files', extensions: ['csv', 'json'] }],
      }),
    ),
  );
  registerHandler(channels.runner.data.clear, async (request) => {
    await runner.clearData(request.targetId);
    return { ok: true as const };
  });
  registerHandler(channels.runner.run, (request) => runner.run(request));
  registerHandler(channels.runner.cancel, (request) => Promise.resolve(runner.cancel(request.runId)));
  registerHandler(channels.runner.history.list, (request) => runner.historyList(request.targetId));
  registerHandler(channels.runner.history.get, (request) => runner.historyGet(request.targetId, request.runId));
}
