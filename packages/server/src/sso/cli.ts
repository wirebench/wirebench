/**
 * `wirebench-server admin scim-token …` (saml-scim spec §3.4): the same functions as the API routes, for an
 * operator setting up provisioning from the host. The licence feature is required here too.
 */
import type { ServerCommand } from '../args.js';
import { SYSTEM_SOURCE, type LicenseService, type ServerContext } from '../context.js';
import { ExitCode, type ServerIo } from '../io.js';
import { featureRequired } from '../licensing/errors.js';
import * as repo from './repo.js';
import { createScimToken, revokeScimToken } from './scim-tokens.js';
import { listGroupSummaries, scimGroupNotFound, setGroupLink } from './group-links.js';
import * as teamsRepo from '../teams/repo.js';
import { teamNotFound } from '../teams/errors.js';
import type { TenantScope } from '../tenancy/scope.js';

export type ScimTokenCommand = Extract<ServerCommand, { command: `admin-scim-token-${string}` }>;
export type ScimGroupCommand = Extract<ServerCommand, { command: `admin-scim-group-${string}` }>;

export interface ScimCliEnv {
  readonly ctx: Pick<ServerContext, 'tenancy' | 'hooks'> & { readonly license: Pick<LicenseService, 'state'> };
  readonly now: () => Date;
}

/** `scope` is the admin command line's tenant (`identity/cli.ts`), whose license decides. */
export async function runScimTokenCommand(
  command: ScimTokenCommand,
  env: ScimCliEnv,
  scope: TenantScope,
  io: ServerIo,
): Promise<number> {
  if (!(await env.ctx.license.state(scope)).features.includes('sso-provisioning'))
    throw featureRequired('sso-provisioning');
  switch (command.command) {
    case 'admin-scim-token-create': {
      const created = await createScimToken(env, scope, command.name, null, SYSTEM_SOURCE);
      io.stdout.write(
        `SCIM token ${created.name} (${created.id})\n${created.token}\nGive it to the identity provider now: it is not shown again.\n`,
      );
      return ExitCode.Ok;
    }
    case 'admin-scim-token-list': {
      io.stdout.write(`${'id'.padEnd(26)}  ${'name'.padEnd(32)}  ${'created'.padEnd(24)}  last used\n`);
      for (const row of await repo.listScimTokens(env.ctx.tenancy.db(scope))) {
        io.stdout.write(
          `${row.id}  ${row.name.padEnd(32)}  ${row.createdAt.padEnd(24)}  ${row.lastUsedAt ?? 'never'}\n`,
        );
      }
      return ExitCode.Ok;
    }
    case 'admin-scim-token-revoke':
      await revokeScimToken(env, scope, command.id, SYSTEM_SOURCE);
      io.stdout.write(`Revoked ${command.id}\n`);
      return ExitCode.Ok;
  }
}

/** A group by id, or by its name ignoring case. */
async function groupIdOf(env: ScimCliEnv, scope: TenantScope, value: string): Promise<string> {
  const groups = await listGroupSummaries(env, scope);
  const found =
    groups.find((group) => group.id === value) ??
    groups.find((group) => group.displayName.toLowerCase() === value.toLowerCase());
  if (found === undefined) throw scimGroupNotFound();
  return found.id;
}

/** A team by id, or by its name ignoring case. */
async function teamIdOf(env: ScimCliEnv, scope: TenantScope, value: string): Promise<string> {
  const teams = await teamsRepo.allTeams(env.ctx.tenancy.db(scope));
  const found =
    teams.find((team) => team.id === value) ?? teams.find((team) => team.name.toLowerCase() === value.toLowerCase());
  if (found === undefined) throw teamNotFound();
  return found.id;
}

/** `scope` is the admin command line's tenant (`identity/cli.ts`). */
export async function runScimGroupCommand(
  command: ScimGroupCommand,
  env: ScimCliEnv,
  scope: TenantScope,
  io: ServerIo,
): Promise<number> {
  if (!(await env.ctx.license.state(scope)).features.includes('sso-provisioning'))
    throw featureRequired('sso-provisioning');
  switch (command.command) {
    case 'admin-scim-group-list': {
      io.stdout.write(`${'id'.padEnd(26)}  ${'name'.padEnd(32)}  members  team\n`);
      for (const group of await listGroupSummaries(env, scope)) {
        io.stdout.write(
          `${group.id}  ${group.displayName.padEnd(32)}  ${String(group.memberCount).padStart(7)}  ${group.team?.name ?? '(not linked)'}\n`,
        );
      }
      return ExitCode.Ok;
    }
    case 'admin-scim-group-link': {
      const linked = await setGroupLink(
        env,
        scope,
        await groupIdOf(env, scope, command.group),
        await teamIdOf(env, scope, command.team),
        SYSTEM_SOURCE,
      );
      io.stdout.write(`Linked ${linked.displayName} to ${linked.team!.name}\n`);
      return ExitCode.Ok;
    }
    case 'admin-scim-group-unlink': {
      const unlinked = await setGroupLink(env, scope, await groupIdOf(env, scope, command.group), null, SYSTEM_SOURCE);
      io.stdout.write(`Unlinked ${unlinked.displayName}\n`);
      return ExitCode.Ok;
    }
  }
}
