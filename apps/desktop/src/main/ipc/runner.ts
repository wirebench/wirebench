/**
 * Registers the `runner.*` IPC channels (#336): read and change a target's Runner settings, choose its
 * data file through main's own picker (the renderer never names a path), run it, stop it, and read
 * its past runs.
 */

import { channels } from '../../shared/ipc.js';
import type { RecordsReadPicks } from '../dialog-picks.js';
import type { NativeDialogs } from '../native-dialogs.js';
import type { RunnerService } from '../runner/runner-service.js';
import { registerHandler, type HandlerTable } from './register.js';

export function registerRunnerChannels(
  table: HandlerTable,
  runner: RunnerService,
  picks: RecordsReadPicks,
  dialogs: Pick<NativeDialogs, 'pickFile'>,
): void {
  registerHandler(table, channels.runner.state, (request) => runner.state(request.targetId));
  registerHandler(table, channels.runner.settings.set, async (request) => {
    await runner.setSettings(request.targetId, request.settings);
    return { ok: true as const };
  });
  registerHandler(table, channels.runner.data.choose, (request, sender) =>
    runner.chooseData(request.targetId, () =>
      dialogs.pickFile(sender, picks, {
        title: 'Choose a data file',
        filters: [{ name: 'Data files', extensions: ['csv', 'json'] }],
      }),
    ),
  );
  registerHandler(table, channels.runner.data.clear, async (request) => {
    await runner.clearData(request.targetId);
    return { ok: true as const };
  });
  registerHandler(table, channels.runner.run, (request) => runner.run(request));
  registerHandler(table, channels.runner.cancel, (request) => Promise.resolve(runner.cancel(request.runId)));
  registerHandler(table, channels.runner.history.list, (request) => runner.historyList(request.targetId));
  registerHandler(table, channels.runner.history.get, (request) => runner.historyGet(request.targetId, request.runId));
}
