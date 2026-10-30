/**
 * `wirebench-server admin schedules …` (scheduled-runs spec §3.8): what an operator on the box needs when
 * a schedule misbehaves, without signing in. It needs no license, like the audit commands: a server
 * whose license lapsed can still have its schedules switched off. `enable` and `disable` are recorded as
 * `schedule.updated` with the system actor; `runs` writes NDJSON for a script to read.
 */
import type { ServerCommand } from '../args.js';
import { recordAudit, SYSTEM_SOURCE, type ServerHooks } from '../context.js';
import type { TenantDb } from '../tenancy/tenant-db.js';
import { ExitCode, type ServerIo } from '../io.js';
import { nextFire } from './cron.js';
import * as repo from './repo.js';

type SchedulesCommand = Extract<ServerCommand, { command: `admin-schedules-${string}` }>;

export interface SchedulesCliEnv {
  /** The admin command line's tenant's database (`identity/cli.ts`). */
  readonly db: TenantDb;
  readonly hooks: ServerHooks;
  readonly now: () => Date;
}

const notFound = (id: string): string => `schedules-not-found: no schedule with id ${id}\n`;

export async function runSchedulesCommand(
  command: SchedulesCommand,
  env: SchedulesCliEnv,
  io: ServerIo,
): Promise<number> {
  switch (command.command) {
    case 'admin-schedules-list': {
      const rows = await repo.allSchedules(env.db, command.workspace);
      const last = await repo.lastRunsOf(
        env.db,
        rows.map((row) => row.id),
      );
      io.stdout.write(
        `${'id'.padEnd(26)}  ${'workspace'.padEnd(26)}  enabled  ${'next run'.padEnd(24)}  ${'last'.padEnd(9)}  name\n`,
      );
      for (const row of rows) {
        const enabled = (row.enabled ? 'yes' : 'no').padEnd(7);
        const next = (row.nextRunAt ?? '-').padEnd(24);
        const status = (last.get(row.id)?.status ?? '-').padEnd(9);
        io.stdout.write(`${row.id}  ${row.workspaceId}  ${enabled}  ${next}  ${status}  ${row.name}\n`);
      }
      return ExitCode.Ok;
    }
    case 'admin-schedules-enable':
    case 'admin-schedules-disable': {
      const enabled = command.command === 'admin-schedules-enable';
      const outcome = await env.db.transaction(async (tx) => {
        const row = await repo.scheduleAnywhere(tx, command.id, true);
        if (row === undefined) return 'missing';
        if (row.enabled === enabled) return 'unchanged';
        const at = env.now();
        await repo.setEnabled(tx, row.id, enabled, enabled ? nextFire(row.cron, row.timeZone, at) : null, at);
        await recordAudit(env.hooks, tx, {
          ...SYSTEM_SOURCE,
          action: 'schedule.updated',
          target: { kind: 'schedule', id: row.id },
          workspaceId: row.workspaceId,
          details: { name: row.name, fields: ['enabled'], enabled },
        });
        return 'changed';
      });
      if (outcome === 'missing') {
        io.stderr.write(notFound(command.id));
        return 1;
      }
      const word = enabled ? 'enabled' : 'disabled';
      io.stdout.write(
        outcome === 'changed' ? `Schedule ${command.id} ${word}\n` : `Schedule ${command.id} was already ${word}\n`,
      );
      return ExitCode.Ok;
    }
    case 'admin-schedules-runs': {
      const row = await repo.scheduleAnywhere(env.db, command.id);
      if (row === undefined) {
        io.stderr.write(notFound(command.id));
        return 1;
      }
      for (const run of await repo.runsPage(env.db, row.id, { limit: command.limit })) {
        io.stdout.write(`${JSON.stringify(run)}\n`);
      }
      return ExitCode.Ok;
    }
  }
}
