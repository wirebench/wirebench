import type { Capability } from '@shared/capabilities.js';

export type { Capability };

/**
 * Whether the connected host can do `capability` (hosted edition spec §3.1): what the preload or the
 * browser bootstrap put in `window.wirebench.env.capabilities`. The one way the renderer asks what a host can
 * do; only {@link isBrowserTab} reads `env.host`. A feature that needs a capability is not offered without it, and the host refuses
 * the channel anyway (`host-capability-missing`), so this decides what is shown, never what is allowed.
 *
 * No list at all (a renderer test's stub, a preload older than the field) means the desktop: every
 * capability, so the app renders as it always has.
 */
export function hasCapability(capability: Capability): boolean {
  const capabilities = (globalThis as { wirebench?: { env?: { capabilities?: readonly string[] } } }).wirebench?.env
    ?.capabilities;
  return capabilities === undefined || capabilities.includes(capability);
}

/**
 * The hint under a secret field: where the value is kept. The OS keychain where the host has one, else
 * sealed on the server (hosted edition spec §3.5), where a value is never read back.
 */
export function secretKeptHint(desktop: string): string {
  return hasCapability('keychain') ? desktop : 'Sealed on the server and never shown again.';
}

/**
 * The tab's own sign-out, when the API has one: the browser bootstrap sets `env.signOut`, since a tab's
 * account is the server's and `account.signOut` is refused there. The desktop has none, and signs out
 * of each server through the account channel as before.
 */
export function tabSignOut(): (() => void) | undefined {
  return (globalThis as { wirebench?: { env?: { signOut?: () => void } } }).wirebench?.env?.signOut;
}

/** One of `env`'s optional members, when the browser bootstrap set it; the desktop preload sets none of these. */
function envMember<K extends 'signOutAll' | 'switchAccount' | 'addAccount' | 'rememberedAccounts'>(
  key: K,
): BrowserAccountActions[K] | undefined {
  return (globalThis as { wirebench?: { env?: Partial<BrowserAccountActions> } }).wirebench?.env?.[key];
}

/** Another account the tab's browser holds, as the bootstrap's `env.rememberedAccounts` lists it. */
export interface TabRememberedAccount {
  readonly userId: string;
  readonly displayName: string;
  readonly email: string;
  readonly username: string | null;
  readonly photo: { readonly version: string } | null;
}

/** The browser's account actions (switch accounts spec §5), as `env` carries them. */
interface BrowserAccountActions {
  readonly signOutAll: () => void;
  readonly switchAccount: (userId: string) => void;
  readonly addAccount: () => void;
  readonly rememberedAccounts: () => Promise<readonly TabRememberedAccount[]>;
}

/** Signs out of every account the tab's browser holds (`env.signOutAll`); `undefined` on the desktop. */
export function tabSignOutAll(): (() => void) | undefined {
  return envMember('signOutAll');
}

/** Makes another account the tab's browser holds active; the tab reloads as them. `undefined` on the desktop. */
export function tabSwitchAccount(): ((userId: string) => void) | undefined {
  return envMember('switchAccount');
}

/** The sign-in page in *Add an account* mode (`env.addAccount`); `undefined` on the desktop. */
export function tabAddAccount(): (() => void) | undefined {
  return envMember('addAccount');
}

/** Reads the other accounts the tab's browser holds with the page's cookie; `undefined` on the desktop. */
export function tabRememberedAccounts(): (() => Promise<readonly TabRememberedAccount[]>) | undefined {
  return envMember('rememberedAccounts');
}

/**
 * Whether this window has a local agent to route sends to: the browser bootstrap sets `env.agent`
 * (hosted edition spec §18.3), the desktop preload never does. Asked about the API's shape, never `host`.
 */
export function hasAgent(): boolean {
  return (globalThis as { wirebench?: { env?: { agent?: unknown } } }).wirebench?.env?.agent !== undefined;
}

/**
 * Whether this window is the browser client (`env.host === 'browser'`), not the desktop app. The one reader of
 * `host`: everything else asks {@link hasCapability}. It is about which *app* is running, not what the host can do,
 * because team management is the browser client's (team management in the browser §1, ruling 2). No `env` (a
 * renderer test's stub) is the desktop.
 */
export function isBrowserTab(): boolean {
  return (globalThis as { wirebench?: { env?: { host?: string } } }).wirebench?.env?.host === 'browser';
}
