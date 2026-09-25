/**
 * The `account.*` channels over {@link AccountService}. The renderer sends a password once and
 * gets an account back; the token and its secret-store ref stay in main.
 */
import type { ServerAccount } from '@wirebench/engine';
import { channels } from '../../shared/ipc.js';
import type { AccountWire } from '../../shared/wire-types.js';
import type { AccountService } from '../account-service.js';
import { registerHandler } from './register.js';

export interface AccountChannelDeps {
  readonly accounts: Pick<
    AccountService,
    | 'list'
    | 'probe'
    | 'signInLocal'
    | 'startOidc'
    | 'cancelSignIn'
    | 'lookupInvitation'
    | 'acceptInvitation'
    | 'signOut'
    | 'remove'
  >;
}

/** Everything but the secret-store ref; `signedOut` becomes a plain boolean. */
export function toAccountWire(account: ServerAccount): AccountWire {
  return {
    url: account.url,
    userId: account.userId,
    email: account.email,
    displayName: account.displayName,
    deviceName: account.deviceName,
    signedOut: account.signedOut === true,
    addedAt: account.addedAt,
  };
}

export function registerAccountChannels(deps: AccountChannelDeps): void {
  const servers = (): { servers: AccountWire[] } => ({ servers: deps.accounts.list().map(toAccountWire) });

  registerHandler(channels.account.list, () => Promise.resolve(servers()));
  registerHandler(channels.account.probe, (request) => deps.accounts.probe(request.url));
  registerHandler(channels.account.signInLocal, async (request) => ({
    account: toAccountWire(
      await deps.accounts.signInLocal({
        url: request.url,
        email: request.email,
        password: request.password,
        ...(request.deviceName !== undefined ? { deviceName: request.deviceName } : {}),
      }),
    ),
  }));
  registerHandler(channels.account.startOidc, async (request) => ({
    account: toAccountWire(
      await deps.accounts.startOidc({
        url: request.url,
        ...(request.deviceName !== undefined ? { deviceName: request.deviceName } : {}),
      }),
    ),
  }));
  registerHandler(channels.account.cancelSignIn, () => Promise.resolve(deps.accounts.cancelSignIn()));
  registerHandler(channels.account.lookupInvitation, (request) => deps.accounts.lookupInvitation(request));
  registerHandler(channels.account.acceptInvitation, async (request) => ({
    account: toAccountWire(
      await deps.accounts.acceptInvitation({
        url: request.url,
        secret: request.secret,
        displayName: request.displayName,
        password: request.password,
        ...(request.deviceName !== undefined ? { deviceName: request.deviceName } : {}),
      }),
    ),
  }));
  registerHandler(channels.account.signOut, async (request) => {
    await deps.accounts.signOut(request.url);
    return servers();
  });
  registerHandler(channels.account.remove, async (request) => {
    await deps.accounts.remove(request.url);
    return servers();
  });
}
