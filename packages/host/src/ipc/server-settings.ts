/**
 * `serverSettings.*`, `tenantBilling.get`, `tenantExports.*` and `tenantDeletion.*` (hosted edition spec §22.9–§22.13):
 * the *Server* page of Settings, on the account's session. The server checks every save and every role; main only
 * adds the token. An export is saved by main: it picks the file, and writes it only once the server has answered 2xx,
 * through a temporary file renamed into place on success, so neither a refusal nor a broken download leaves a file. The renderer never sees the token, nor a URL that holds one.
 */
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createWriteStream, type WriteStream } from 'node:fs';
import { rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { channels } from '@wirebench/wire/ipc';
import type { RecordsWritePicks } from '../dialog-picks.js';
import type { NativeDialogs } from '../native-dialogs.js';
import type { ServerClient } from '../server-client.js';
import { withToken, type TokenSource } from '../server-token.js';
import { registerHandler, type HandlerTable } from './register.js';

export interface ServerSettingsChannelDeps {
  readonly client: Pick<
    ServerClient,
    | 'getServerSettings'
    | 'saveServerSettings'
    | 'clearServerSettings'
    | 'getTenantBilling'
    | 'listTenantExports'
    | 'requestTenantExport'
    | 'streamTenantExport'
    | 'requestTenantDeletion'
    | 'cancelTenantDeletion'
  >;
  readonly accounts: TokenSource;
  readonly picks: RecordsWritePicks;
  /** The Save-as picker an export download runs. */
  readonly dialogs: Pick<NativeDialogs, 'pickSaveFile'>;
  /** Injected clock for the default file name. */
  readonly now?: () => Date;
}

/** The Save-as dialog's suggestion; the server's own name holds the slug, which main does not know before the answer. */
export const exportFileName = (at: Date): string =>
  `wirebench-export-${at.toISOString().slice(0, 19).replace(/[-:]/g, '')}Z.tar.gz`;

/**
 * Streams an export into `path` without ever leaving a broken file there: the bytes go to a temporary file beside it
 * (same directory, so the rename is atomic), each chunk waits for `drain` when the disk is slower than the network,
 * and only a stream that ended well is renamed into place. Any failure, the server's, the network's or the disk's,
 * removes the temporary file and leaves whatever was at `path` untouched. Resolves the bytes written.
 */
export async function saveExport(
  path: string,
  stream: (open: () => (chunk: Uint8Array) => Promise<void> | void) => Promise<void>,
): Promise<number> {
  const temp = join(dirname(path), `.${basename(path)}.${randomBytes(6).toString('hex')}.part`);
  const state: { out?: WriteStream; error?: Error; size: number } = { size: 0 };
  try {
    await stream(() => {
      const file = createWriteStream(temp, { flags: 'wx' });
      // An unhandled 'error' on a stream would be an uncaught exception in main.
      file.on('error', (e) => {
        state.error ??= e;
      });
      state.out = file;
      return async (chunk) => {
        if (state.error !== undefined) throw state.error;
        state.size += chunk.byteLength;
        // Waits for the disk; `once` rejects on an 'error' while waiting, so a failed write ends it, never hangs.
        if (!file.write(chunk)) await once(file, 'drain');
      };
    });
    const file = state.out;
    if (file === undefined) throw new Error('the export stream never opened');
    file.end();
    await once(file, 'close');
    if (state.error !== undefined) throw state.error;
    await rename(temp, path);
    return state.size;
  } catch (error) {
    const file = state.out;
    if (file !== undefined && !file.closed) {
      file.destroy();
      await once(file, 'close').catch(() => undefined);
    }
    await rm(temp, { force: true });
    throw state.error ?? error;
  }
}

export function registerServerSettingsChannels(table: HandlerTable, deps: ServerSettingsChannelDeps): void {
  const c = deps.client;
  registerHandler(table, channels.serverSettings.get, (r) =>
    withToken(deps, r.url, (url, token) => c.getServerSettings(url, token)),
  );
  registerHandler(table, channels.serverSettings.save, (r) =>
    withToken(deps, r.url, (url, token) => c.saveServerSettings(url, token, r.section, r.value)),
  );
  registerHandler(table, channels.serverSettings.clear, (r) =>
    withToken(deps, r.url, (url, token) => c.clearServerSettings(url, token, r.section)),
  );

  registerHandler(table, channels.tenantBilling.get, (r) =>
    withToken(deps, r.url, (url, token) => c.getTenantBilling(url, token)),
  );

  registerHandler(table, channels.tenantExports.list, (r) =>
    withToken(deps, r.url, async (url, token) => ({ exports: await c.listTenantExports(url, token) })),
  );
  registerHandler(table, channels.tenantExports.request, (r) =>
    withToken(deps, r.url, async (url, token) => ({ export: await c.requestTenantExport(url, token) })),
  );
  registerHandler(table, channels.tenantExports.download, async (r, sender) => {
    const path = await deps.dialogs.pickSaveFile(sender, deps.picks, {
      title: 'Save export',
      filters: [{ name: 'Wirebench export', extensions: ['gz'] }],
      defaultPath: exportFileName((deps.now ?? (() => new Date()))()),
    });
    if (path === undefined) return { saved: false as const };
    const sizeBytes = await saveExport(path, (open) =>
      withToken(deps, r.url, (url, token) => c.streamTenantExport(url, token, r.id, open)),
    );
    return { saved: true as const, path, sizeBytes };
  });

  registerHandler(table, channels.tenantDeletion.request, (r) =>
    withToken(deps, r.url, (url, token) => c.requestTenantDeletion(url, token, r.slug.trim())),
  );
  registerHandler(table, channels.tenantDeletion.cancel, (r) =>
    withToken(deps, r.url, async (url, token) => ({ cancelled: await c.cancelTenantDeletion(url, token) })),
  );
}
