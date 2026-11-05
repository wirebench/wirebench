/**
 * `serverSettings.*`, `tenantBilling.get`, `tenantExports.*` and `tenantDeletion.*` (hosted edition spec §22.9–§22.13):
 * the *Server* page of Settings, on the account's session. The server checks every save and every role; main only
 * adds the token. An export is saved by main: it picks the file, and opens it only once the server has answered 2xx,
 * so a refusal leaves no empty file behind. The renderer never sees the token, nor a URL that holds one.
 */
import { once } from 'node:events';
import { createWriteStream, type WriteStream } from 'node:fs';
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
    let out: WriteStream | undefined;
    let size = 0;
    let writeError: Error | undefined;
    try {
      await withToken(deps, r.url, (url, token) =>
        c.streamTenantExport(url, token, r.id, () => {
          const file = createWriteStream(path);
          // An unhandled 'error' on a stream would be an uncaught exception in main.
          file.on('error', (e) => {
            writeError ??= e;
          });
          out = file;
          return (chunk) => {
            size += chunk.byteLength;
            file.write(chunk);
          };
        }),
      );
    } finally {
      if (out !== undefined && !out.destroyed && !out.closed) {
        out.end();
        await once(out, 'close');
      }
    }
    if (writeError !== undefined) throw writeError;
    return { saved: true as const, path, sizeBytes: size };
  });

  registerHandler(table, channels.tenantDeletion.request, (r) =>
    withToken(deps, r.url, (url, token) => c.requestTenantDeletion(url, token, r.slug.trim())),
  );
  registerHandler(table, channels.tenantDeletion.cancel, (r) =>
    withToken(deps, r.url, async (url, token) => ({ cancelled: await c.cancelTenantDeletion(url, token) })),
  );
}
