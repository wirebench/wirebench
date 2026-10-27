/** `provisioning.*` (saml-scim spec §3.7): the Provisioning tab's calls, on the account's session. */
import { channels } from '../../shared/ipc.js';
import type { ServerClient } from '../server-client.js';
import { withToken, type TokenSource } from '../server-token.js';
import { registerHandler, type HandlerTable } from './register.js';

export interface ProvisioningChannelDeps {
  readonly client: Pick<
    ServerClient,
    | 'samlInfo'
    | 'listScimTokens'
    | 'createScimToken'
    | 'revokeScimToken'
    | 'listScimGroups'
    | 'linkScimGroup'
    | 'unlinkScimGroup'
  >;
  readonly accounts: TokenSource;
}

export function registerProvisioningChannels(table: HandlerTable, deps: ProvisioningChannelDeps): void {
  const c = deps.client;
  registerHandler(table, channels.provisioning.info, (r) =>
    withToken(deps, r.url, (url, token) => c.samlInfo(url, token)),
  );
  registerHandler(table, channels.provisioning.listTokens, (r) =>
    withToken(deps, r.url, async (url, token) => ({ tokens: await c.listScimTokens(url, token) })),
  );
  registerHandler(table, channels.provisioning.createToken, (r) =>
    withToken(deps, r.url, (url, token) => c.createScimToken(url, token, r.name)),
  );
  registerHandler(table, channels.provisioning.revokeToken, (r) =>
    withToken(deps, r.url, async (url, token) => {
      await c.revokeScimToken(url, token, r.tokenId);
      return { revoked: true as const };
    }),
  );
  registerHandler(table, channels.provisioning.listGroups, (r) =>
    withToken(deps, r.url, async (url, token) => ({ groups: await c.listScimGroups(url, token) })),
  );
  registerHandler(table, channels.provisioning.linkGroup, (r) =>
    withToken(deps, r.url, (url, token) =>
      r.teamId === null ? c.unlinkScimGroup(url, token, r.groupId) : c.linkScimGroup(url, token, r.groupId, r.teamId),
    ),
  );
}
