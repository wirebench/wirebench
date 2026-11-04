/**
 * `wirebench-server admin instances` (hosted edition spec §20.10): the live `server_instances` rows, one line each,
 * with the holder, the address, the version, the age and the last renew. The table names processes, so nothing
 * here prints, reads or takes a tenant.
 */
import { WirebenchError } from '@wirebench/engine';
import { ConfigError, forgetDatabaseUrls, loadConfig, migrationUrlOf, type ServerConfig } from '../config.js';
import { ADMIN_APPLICATION_NAME, createDatabase } from '../db/pool.js';
import { ExitCode, packageVersion, type ServerIo } from '../io.js';
import { listLive, type InstanceRow } from './instances.js';

function configOf(io: ServerIo): ServerConfig | number {
  try {
    const config = loadConfig(io.env, packageVersion());
    forgetDatabaseUrls();
    return config;
  } catch (error) {
    if (error instanceof ConfigError) {
      for (const problem of error.problems) io.stderr.write(`${problem.variable}: ${problem.message}\n`);
      return ExitCode.Config;
    }
    throw error;
  }
}

/** `95s`, `12m 5s`, `3h 2m`, `4d 1h`: an age at a glance. */
export function formatAge(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${String(s)}s`;
  if (s < 3600) return `${String(Math.floor(s / 60))}m ${String(s % 60)}s`;
  if (s < 86_400) return `${String(Math.floor(s / 3600))}h ${String(Math.floor((s % 3600) / 60))}m`;
  return `${String(Math.floor(s / 86_400))}d ${String(Math.floor((s % 86_400) / 3600))}h`;
}

/** The table `admin instances` prints: a header, then one row per live instance. */
export function formatInstances(rows: readonly InstanceRow[]): string {
  const lines = [['HOLDER', 'ADDRESS', 'VERSION', 'AGE', 'LAST RENEW']];
  for (const row of rows) {
    lines.push([
      row.holder,
      row.url ?? '-',
      row.version,
      formatAge(row.ageSeconds),
      `${row.renewedAt} (${formatAge(row.renewedSecondsAgo)} ago)`,
    ]);
  }
  const widths = lines[0]!.map((_, column) => Math.max(...lines.map((line) => line[column]!.length)));
  return lines
    .map((line) =>
      line.map((cell, column) => (column === line.length - 1 ? cell : cell.padEnd(widths[column]!))).join('  '),
    )
    .join('\n');
}

export async function runInstances(io: ServerIo): Promise<number> {
  const loaded = configOf(io);
  if (typeof loaded === 'number') return loaded;
  const db = createDatabase(migrationUrlOf(loaded), { applicationName: ADMIN_APPLICATION_NAME, max: 1 });
  try {
    const rows = await listLive(db);
    io.stdout.write(`${formatInstances(rows)}\n`);
    if (rows.length === 0) io.stdout.write('no instance is running\n');
    return ExitCode.Ok;
  } catch (error) {
    const why =
      error instanceof WirebenchError
        ? `${error.code}: ${error.message}`
        : (error as { readonly code?: unknown } | null)?.code === '42P01'
          ? 'migration 0022 is not applied'
          : ((error as NodeJS.ErrnoException | null)?.code ?? 'an unexpected error');
    io.stderr.write(`admin instances failed: ${why}\n`);
    return ExitCode.Migration;
  } finally {
    await db.close();
  }
}
