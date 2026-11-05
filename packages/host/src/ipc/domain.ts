/** `domain.*` (hosted edition spec §23.6): the Domain tab's calls, on the account's session. */
import { channels } from '@wirebench/wire/ipc';
import type { ServerClient } from '../server-client.js';
import { withToken, type TokenSource } from '../server-token.js';
import { registerHandler, type HandlerTable } from './register.js';

export interface DomainChannelDeps {
  readonly client: Pick<
    ServerClient,
    'getCustomDomain' | 'claimCustomDomain' | 'checkCustomDomain' | 'removeCustomDomain'
  >;
  readonly accounts: TokenSource;
}

export function registerDomainChannels(table: HandlerTable, deps: DomainChannelDeps): void {
  const c = deps.client;
  registerHandler(table, channels.domain.get, (r) =>
    withToken(deps, r.url, async (url, token) => ({ domain: (await c.getCustomDomain(url, token)) ?? null })),
  );
  registerHandler(table, channels.domain.claim, (r) =>
    withToken(deps, r.url, async (url, token) => ({
      domain: (await c.claimCustomDomain(url, token, r.name.trim())) ?? null,
    })),
  );
  registerHandler(table, channels.domain.check, (r) =>
    withToken(deps, r.url, async (url, token) => ({ domain: (await c.checkCustomDomain(url, token)) ?? null })),
  );
  registerHandler(table, channels.domain.remove, (r) =>
    withToken(deps, r.url, async (url, token) => {
      await c.removeCustomDomain(url, token);
      return { removed: true as const };
    }),
  );
}
