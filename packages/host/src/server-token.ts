/**
 * The account token for a Wirebench Server call, shared by the Team dialog's channels
 * (`ipc/team.ts`) and `ServerBackend` (server-sync spec §3.1: lifted, not copied). No token reads as
 * signed out without a network call. A server that answers `identity-unauthenticated` marks the
 * account signed out, the same rule `AccountService.refresh` applies at launch. The token never
 * leaves main.
 *
 * Electron-free: `ServerBackend` imports this module, and the server package's contract run imports
 * `ServerBackend` (O4). `AccountService` is imported as a type only.
 */
import { WirebenchError } from '@wirebench/engine';
import type { AccountService, AccountTarget } from './account-service.js';
import { normalizeServerUrl } from './server-client.js';

/** What a caller needs from `AccountService`: the token, and the rule that a rejected one signs the account out. */
export type TokenSource = Pick<AccountService, 'tokenFor' | 'markSignedOut'>;

/**
 * Runs `call` with the token of the account `target` names (switch accounts ruling 1: a URL alone stands for
 * that server's active-or-only account). No token, or one the server rejects, reads as signed out.
 */
export async function withToken<T>(
  deps: { readonly accounts: TokenSource },
  target: AccountTarget,
  call: (origin: string, token: string) => Promise<T>,
): Promise<T> {
  const origin = normalizeServerUrl(typeof target === 'string' ? target : target.url);
  const account = typeof target === 'string' ? origin : { url: origin, userId: target.userId };
  const token = await deps.accounts.tokenFor(account);
  if (token === undefined) throw new WirebenchError('account-signed-out', `Sign in to ${origin} first.`);
  try {
    return await call(origin, token);
  } catch (error) {
    if (error instanceof WirebenchError && error.code === 'identity-unauthenticated')
      deps.accounts.markSignedOut(account);
    throw error;
  }
}
