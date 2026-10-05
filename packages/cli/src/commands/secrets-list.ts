import {
  envVariablesFor,
  parseSecretPseudoRef,
  secretNeedsOf,
  secretSourcesHash,
  sharedTrusted,
} from '@wirebench/engine';
import type { SecretsListArgs } from '../args.js';
import { ExitCode } from '../exit-codes.js';
import type { CliIo } from '../main.js';
import { loadSelection } from './run.js';

const HEADER = ['VARIABLE', 'STATE', 'SOURCE', 'PURPOSE', 'USED BY'] as const;

/**
 * `wirebench secrets list`: what a run of this selection needs set, so a pipeline can be wired up
 * before it fails. It reads the environment only to say `set` or `missing`; a value is never
 * printed, and never even held past the check. A name the workspace maps to a secret source shows
 * as `mapped`, and the mapping's hash is printed so a pipeline can pin it.
 */
export async function secretsListCommand(args: SecretsListArgs, io: CliIo): Promise<ExitCode> {
  const loaded = await loadSelection(args, io);
  if (typeof loaded === 'number') {
    return loaded;
  }
  const needs = secretNeedsOf(loaded.selected, loaded.project, args.vars, loaded.workspace?.workspace);
  if (needs.length === 0) {
    io.stdout.write('No secrets needed.\n');
    return ExitCode.Ok;
  }
  const shared = args.secretSources.enabled ? (loaded.workspace?.workspace.secretSources ?? {}) : {};
  const hash = secretSourcesHash(shared);
  const trusted = hash !== undefined && sharedTrusted(args.secretSources.trust, hash);
  let missing = false;
  const rows = needs.map((need) => {
    const variables = envVariablesFor(need);
    const isSet = variables.some((variable) => (io.env[variable] ?? '').length > 0);
    const name = parseSecretPseudoRef(need.ref);
    const mapped = name !== undefined ? shared[name] : undefined;
    const source = isSet
      ? 'env'
      : mapped === undefined
        ? '—'
        : mapped.kind === 'invalid'
          ? 'invalid'
          : `${mapped.kind}${trusted ? '' : ' (untrusted)'}`;
    missing ||= !isSet && (mapped === undefined || mapped.kind === 'invalid');
    const state = isSet ? 'set' : mapped !== undefined && mapped.kind !== 'invalid' ? 'mapped' : 'missing';
    return [variables[0] ?? '', state, source, need.purpose, need.usedBy.join(', ')];
  });
  const table = [[...HEADER], ...rows];
  const widths = HEADER.map((_, column) => Math.max(...table.map((row) => (row[column] ?? '').length)));
  for (const row of table) {
    const cells = row.map((cell, column) => (column === row.length - 1 ? cell : cell.padEnd(widths[column] ?? 0)));
    io.stdout.write(`${cells.join('  ')}\n`);
  }
  if (hash !== undefined) {
    io.stdout.write(
      `\nSecret sources hash: ${hash}${trusted ? ' (trusted)' : ' (pass --trust-secret-sources-hash to trust it)'}\n`,
    );
  }
  return missing ? ExitCode.RunError : ExitCode.Ok;
}
