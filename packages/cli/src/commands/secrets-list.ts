import { envVariablesFor, secretNeedsOf } from '@wirebench/engine';
import type { SecretsListArgs } from '../args.js';
import { ExitCode } from '../exit-codes.js';
import type { CliIo } from '../main.js';
import { loadSelection } from './run.js';

const HEADER = ['VARIABLE', 'STATE', 'PURPOSE', 'USED BY'] as const;

/**
 * `wirebench secrets list`: what a run of this selection needs set, so a pipeline can be wired up
 * before it fails. It reads the environment only to say `set` or `missing`; a value is never
 * printed, and never even held past the check.
 */
export async function secretsListCommand(args: SecretsListArgs, io: CliIo): Promise<ExitCode> {
  const loaded = await loadSelection(args, io);
  if (typeof loaded === 'number') {
    return loaded;
  }
  const needs = secretNeedsOf(loaded.selected, loaded.project, args.vars);
  if (needs.length === 0) {
    io.stdout.write('No secrets needed.\n');
    return ExitCode.Ok;
  }
  let missing = false;
  const rows = needs.map((need) => {
    const variables = envVariablesFor(need);
    const isSet = variables.some((variable) => (io.env[variable] ?? '').length > 0);
    missing ||= !isSet;
    return [variables[0] ?? '', isSet ? 'set' : 'missing', need.purpose, need.usedBy.join(', ')];
  });
  const table = [[...HEADER], ...rows];
  const widths = HEADER.map((_, column) => Math.max(...table.map((row) => (row[column] ?? '').length)));
  for (const row of table) {
    const cells = row.map((cell, column) => (column === row.length - 1 ? cell : cell.padEnd(widths[column] ?? 0)));
    io.stdout.write(`${cells.join('  ')}\n`);
  }
  return missing ? ExitCode.RunError : ExitCode.Ok;
}
