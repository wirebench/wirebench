/** `ciTokens.*` (callback-assertion §5): the Devices & tokens section's calls, on the account's session. */
import { channels } from '../../shared/ipc.js';
import type { ServerClient } from '../server-client.js';
import { withToken, type TokenSource } from '../server-token.js';
import { registerHandler } from './register.js';

export interface CiTokenChannelDeps {
  readonly client: Pick<ServerClient, 'listCiTokens' | 'createCiToken' | 'revokeCiToken'>;
  readonly accounts: TokenSource;
}

export function registerCiTokenChannels(deps: CiTokenChannelDeps): void {
  const c = deps.client;
  registerHandler(channels.ciTokens.list, (r) =>
    withToken(deps, r.url, async (url, token) => ({ tokens: await c.listCiTokens(url, token, r.workspaceId) })),
  );
  registerHandler(channels.ciTokens.create, (r) =>
    withToken(deps, r.url, (url, token) => c.createCiToken(url, token, r.workspaceId, r.name)),
  );
  registerHandler(channels.ciTokens.revoke, (r) =>
    withToken(deps, r.url, async (url, token) => {
      await c.revokeCiToken(url, token, r.workspaceId, r.tokenId);
      return { revoked: true as const };
    }),
  );
}
