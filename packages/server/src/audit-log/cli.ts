/**
 * `wirebench-server admin audit export …` (audit-log spec §3.5): the lines the endpoint streams, to
 * stdout, for a scheduled collector on the box. It needs no license: the operator has the database. It
 * records `audit.exported` with the system actor.
 */
import { auditExportQuerySchema } from '@wirebench/engine';
import type { ServerCommand } from '../args.js';
import { recordAudit, SYSTEM_SOURCE, type Querier, type ServerHooks } from '../context.js';
import { ExitCode, type ServerIo } from '../io.js';
import { exportedEvent, exportLines, filterOf } from './routes.js';

type AuditCommand = Extract<ServerCommand, { command: 'admin-audit-export' }>;

export async function runAuditCommand(
  command: AuditCommand,
  env: { readonly db: Querier; readonly hooks: ServerHooks; readonly now: () => Date },
  io: ServerIo,
): Promise<number> {
  const parsed = auditExportQuerySchema.safeParse({
    ...(command.from !== undefined ? { from: new Date(command.from).toISOString() } : {}),
    ...(command.to !== undefined ? { to: new Date(command.to).toISOString() } : {}),
    ...(command.action !== undefined ? { action: command.action } : {}),
    ...(command.workspace !== undefined ? { workspaceId: command.workspace } : {}),
  });
  if (!parsed.success) {
    io.stderr.write(`${parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('\n')}\n`);
    return ExitCode.Config;
  }
  const query = parsed.data;
  const lines = exportLines(env.db, filterOf(query), (count) =>
    recordAudit(env.hooks, env.db, exportedEvent(SYSTEM_SOURCE, query, count)),
  );
  for await (const line of lines) io.stdout.write(line);
  return ExitCode.Ok;
}
