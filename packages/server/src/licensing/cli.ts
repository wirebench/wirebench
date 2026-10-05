/**
 * `wirebench-server admin license …` (licensing spec §3.7): the endpoints' code, for an operator who
 * installs from a provisioning script or before anyone is a server admin. Its announcement reaches
 * nobody, as every admin command's does (identity/cli.ts builds hooks with no listeners).
 */
import { readFile } from 'node:fs/promises';
import { isWirebenchError, type LicenseState } from '@wirebench/engine';
import type { ServerCommand } from '../args.js';
import { recordAudit, SYSTEM_SOURCE, type LicenseChanged, type LicenseService, type ServerHooks } from '../context.js';
import { ExitCode, type ServerIo } from '../io.js';
import { installLicense, removeLicense, type LicenseEnv } from './service.js';

export type LicenseCommand = Extract<ServerCommand, { command: `admin-license-${string}` }>;

const LABEL = { community: 'Community', team: 'Team', enterprise: 'Enterprise' } as const;

/** What `show` prints, and `install` after it: the License tab's facts, one per line. */
export function describeLicense(state: LicenseState): string {
  const rows: [string, string][] = [];
  if (state.serverId !== undefined) rows.push(['Server id', state.serverId]);
  rows.push(['Edition', `${LABEL[state.edition]} (${state.status})`]);
  if (state.customer !== undefined) rows.push(['Customer', state.customer]);
  if (state.licenseId !== undefined) rows.push(['License', state.licenseId]);
  rows.push(['Seats', `${state.seats.used} of ${state.seats.limit ?? 'unlimited'}`]);
  if (state.expiresAt !== undefined) rows.push(['Expires', state.expiresAt]);
  if (state.status === 'grace' && state.graceUntil !== undefined) rows.push(['Grace until', state.graceUntil]);
  if (state.features.length > 0) rows.push(['Features', state.features.join(', ')]);
  if (state.message !== undefined) rows.push(['Problem', state.message]);
  return rows.map(([label, value]) => `${label.padEnd(12)}${value}\n`).join('');
}

export async function runLicenseCommand(
  command: LicenseCommand,
  env: LicenseEnv & { readonly license: LicenseService; readonly hooks: ServerHooks },
  io: ServerIo,
): Promise<number> {
  switch (command.command) {
    case 'admin-license-show':
      io.stdout.write(describeLicense(await env.license.state()));
      return ExitCode.Ok;
    case 'admin-license-install': {
      let text: string;
      try {
        text = await readFile(command.file, 'utf8');
      } catch (error) {
        io.stderr.write(`cannot read ${command.file}: ${error instanceof Error ? error.message : String(error)}\n`);
        return ExitCode.Config;
      }
      let changed: LicenseChanged;
      try {
        changed = await installLicense(env, text, null);
      } catch (error) {
        // Invalid input, as a usage error is: exit 2 (§3.7).
        if (isWirebenchError(error) && error.code === 'licensing-invalid') {
          io.stderr.write(`licensing-invalid: ${error.message}\n`);
          return ExitCode.Config;
        }
        throw error;
      }
      await recordAudit(env.hooks, env.db, {
        ...SYSTEM_SOURCE,
        action: 'license.installed',
        target: { kind: 'license', ...(changed.licenseId !== undefined ? { id: changed.licenseId } : {}) },
        details: { edition: changed.edition ?? null, via: 'cli' },
      });
      io.stdout.write(describeLicense(await env.license.state()));
      return ExitCode.Ok;
    }
    case 'admin-license-remove': {
      const changed = await removeLicense(env, null);
      if (changed !== undefined) {
        await recordAudit(env.hooks, env.db, {
          ...SYSTEM_SOURCE,
          action: 'license.removed',
          target: { kind: 'license', ...(changed.licenseId !== undefined ? { id: changed.licenseId } : {}) },
          details: { via: 'cli' },
        });
      }
      io.stdout.write(
        changed === undefined
          ? 'No license was installed.\n'
          : `Removed license ${changed.licenseId}. This server is on the Community edition.\n`,
      );
      return ExitCode.Ok;
    }
  }
}
