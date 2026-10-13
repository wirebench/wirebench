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

export type ScimTokenCommand = Extract<ServerCommand, { command: `admin-scim-token-${string}` }>;

export interface ScimCliEnv {
  readonly ctx: Pick<ServerContext, 'db' | 'hooks'> & { readonly license: Pick<LicenseService, 'state'> };
  readonly now: () => Date;
}

export async function runScimTokenCommand(command: ScimTokenCommand, env: ScimCliEnv, io: ServerIo): Promise<number> {
  if (!(await env.ctx.license.state()).features.includes('sso-provisioning')) throw featureRequired('sso-provisioning');
  switch (command.command) {
    case 'admin-scim-token-create': {
      const created = await createScimToken(env, command.name, null, SYSTEM_SOURCE);
      io.stdout.write(
        `SCIM token ${created.name} (${created.id})\n${created.token}\nGive it to the identity provider now: it is not shown again.\n`,
      );
      return ExitCode.Ok;
    }
    case 'admin-scim-token-list': {
      io.stdout.write(`${'id'.padEnd(26)}  ${'name'.padEnd(32)}  ${'created'.padEnd(24)}  last used\n`);
      for (const row of await repo.listScimTokens(env.ctx.db)) {
        io.stdout.write(
          `${row.id}  ${row.name.padEnd(32)}  ${row.createdAt.padEnd(24)}  ${row.lastUsedAt ?? 'never'}\n`,
        );
      }
      return ExitCode.Ok;
    }
    case 'admin-scim-token-revoke':
      await revokeScimToken(env, command.id, SYSTEM_SOURCE);
      io.stdout.write(`Revoked ${command.id}\n`);
      return ExitCode.Ok;
  }
}
