import { channels } from '../../shared/ipc.js';
import { curlForLogEntry } from '../log-curl.js';
import { registerHandler } from './register.js';

/** What the HTTP Log's channels need from main. */
export interface LogChannelDeps {
  readonly showSecrets: { get(): boolean };
}

/** Registers `log.*`: everything the HTTP Log asks main to do with a row it already holds. */
export function registerLogChannels(deps: LogChannelDeps): void {
  registerHandler(channels.log.curl, (request) =>
    Promise.resolve(curlForLogEntry(request.entry, { shell: request.shell, show: deps.showSecrets.get() })),
  );
}
