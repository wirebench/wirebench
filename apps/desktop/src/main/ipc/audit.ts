/**
 * `audit.*` (audit-log spec §3.6, §5.3): the Audit tab's calls, on the account's session. Main picks the
 * export file, and opens it only once the server has answered 2xx (plan ruling 16): a signed-out account,
 * a 403 or an unreachable server leaves no empty file behind. The renderer never sees a path.
 */
import { once } from 'node:events';
import { createWriteStream, type WriteStream } from 'node:fs';
import { channels } from '../../shared/ipc.js';
import type { RecordsWritePicks } from '../dialog-picks.js';
import { pickSaveFile } from '../native-dialogs.js';
import type { ServerClient } from '../server-client.js';
import { withToken, type TokenSource } from '../server-token.js';
import { registerHandler } from './register.js';

export interface AuditChannelDeps {
  readonly client: Pick<ServerClient, 'queryAudit' | 'streamAuditExport'>;
  readonly accounts: TokenSource;
  readonly picks: RecordsWritePicks;
  /** Injected clock for the default file name. */
  readonly now?: () => Date;
}

export const auditFileName = (at: Date): string => `wirebench-audit-${at.toISOString().slice(0, 10)}.ndjson`;

export function registerAuditChannels(deps: AuditChannelDeps): void {
  registerHandler(channels.audit.query, (r) =>
    withToken(deps, r.url, (url, token) => deps.client.queryAudit(url, token, r.query)),
  );

  registerHandler(channels.audit.export, async (r, sender) => {
    const path = await pickSaveFile(sender, deps.picks, {
      title: 'Export audit log',
      filters: [{ name: 'Newline-delimited JSON', extensions: ['ndjson'] }],
      defaultPath: auditFileName((deps.now ?? (() => new Date()))()),
    });
    if (path === undefined) return { saved: false as const };
    let out: WriteStream | undefined;
    let count = 0;
    try {
      await withToken(deps, r.url, (url, token) =>
        deps.client.streamAuditExport(url, token, r.query, () => {
          const file = createWriteStream(path);
          out = file;
          return (chunk) => {
            for (const byte of chunk) if (byte === 0x0a) count += 1;
            file.write(chunk);
          };
        }),
      );
    } finally {
      if (out !== undefined) {
        out.end();
        await once(out, 'close');
      }
    }
    return { saved: true as const, path, count };
  });
}
