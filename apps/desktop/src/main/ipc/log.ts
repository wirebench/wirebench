import { randomUUID } from 'node:crypto';
import { nodeFs, WirebenchError, writeFileAtomic } from '@wirebench/engine';
import { channels } from '../../shared/ipc.js';
import type { RecordsWritePicks } from '../dialog-picks.js';
import type { EngineService } from '../engine-service.js';
import { harFileName, harOf } from '../har.js';
import { curlForLogEntry } from '../log-curl.js';
import type { NativeDialogs } from '../native-dialogs.js';
import { MAIN_KINDS } from '../kinds/kind-main.js';
import { registerHandler, type HandlerTable } from './register.js';
import { toSendDeps, type RequestChannelDeps } from './request.js';

/** What the HTTP Log's channels need from main. */
export interface LogChannelDeps {
  readonly showSecrets: { get(): boolean };
  readonly service: EngineService;
  /** The same deps `request.*` sends with, so a resend writes History and failure rows alike. */
  readonly request: RequestChannelDeps;
  /** Records the HAR path the save dialog returned, as every other write pick is. */
  readonly picks: RecordsWritePicks;
  /** The Save-as picker the HAR export runs. */
  readonly dialogs: Pick<NativeDialogs, 'pickSaveFile'>;
  /** The `creator.version` a HAR file carries. */
  readonly appVersion: string;
}

/** Registers `log.*`: everything the HTTP Log asks main to do with a row it already holds. */
export function registerLogChannels(table: HandlerTable, deps: LogChannelDeps): void {
  // The request channels' own send through the engine, cancelled through the same registry.
  const sendDeps = toSendDeps(deps.service, deps.request);
  registerHandler(table, channels.log.curl, (request) =>
    Promise.resolve(curlForLogEntry(request.entry, { shell: request.shell, show: deps.showSecrets.get() })),
  );

  // Replays the saved request behind a row as it is now — never the row's own (redacted) copy.
  registerHandler(table, channels.log.resend, async (request) => {
    const log = MAIN_KINDS.find((kind) => kind.kind === request.protocol)?.log;
    if (log === undefined) {
      throw new WirebenchError('unknown-protocol', `Rows sent over ${request.protocol} cannot be resent.`);
    }
    return await log.resend({ request, deps, sendDeps, sendId: randomUUID() });
  });

  registerHandler(table, channels.log.exportHar, async (request, sender) => {
    // Always show:false, whatever the toggle says: a HAR file is made to be shared.
    const har = harOf(request.entries, { name: 'Wirebench', version: deps.appVersion });
    // The path is never the renderer's to choose: it comes from the native dialog or the e2e override.
    const path = await deps.dialogs.pickSaveFile(sender, deps.picks, {
      title: 'Export HAR',
      filters: [{ name: 'HAR', extensions: ['har'] }],
      defaultPath: harFileName(new Date()),
    });
    if (path === undefined) {
      return { saved: false };
    }
    await writeFileAtomic(nodeFs, path, Buffer.from(JSON.stringify(har, null, 2), 'utf8'));
    return { saved: true, path };
  });
}
