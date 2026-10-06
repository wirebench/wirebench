/**
 * The `issuedTokens.*` channels: the status of one issued-token entry's SAML token, Fetch now and
 * Clear. Every call names the entry by its configuration and position, and main reads the entry
 * (and the request it is fetched for) from the model: the renderer never hands main an STS URL or a
 * credential reference to use. The assertion crosses only when the session shows secrets.
 */
import { channels } from '../../shared/ipc.js';
import type { IssuedTokensService } from '../issued-tokens.js';
import { registerHandler } from './register.js';

export interface IssuedTokenChannelDeps {
  readonly issuedTokens: Pick<IssuedTokensService, 'status' | 'fetch' | 'clear'>;
  /** The session "show secrets" flag; absent: the assertion never crosses. */
  readonly showSecrets?: { get(): boolean };
}

/** Registers the three `issuedTokens.*` handlers. */
export function registerIssuedTokenChannels(deps: IssuedTokenChannelDeps): void {
  const show = (): boolean => deps.showSecrets?.get() ?? false;
  registerHandler(channels.issuedTokens.status, async (locator) => await deps.issuedTokens.status(locator, show()));
  registerHandler(channels.issuedTokens.fetch, async (locator) => await deps.issuedTokens.fetch(locator, show()));
  registerHandler(channels.issuedTokens.clear, async (locator) => await deps.issuedTokens.clear(locator, show()));
}
