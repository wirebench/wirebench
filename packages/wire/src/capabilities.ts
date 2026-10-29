/**
 * What a host's machine can do (hosted edition spec §2, §3.1). The host package declares a platform's
 * subset; the renderer reads the same list from `window.wirebench.env.capabilities` and hides what the
 * connected host cannot do. A plain const array with no zod, so the renderer may import it eagerly.
 */

/** Every capability there is, in one place; a platform declares the subset it has. */
export const ALL_CAPABILITIES = [
  'files',
  'keychain',
  'ssh',
  'pty',
  'kerberos',
  'dialogs',
  'send:private',
  'send:public',
  'secret-sources',
  'team-secrets',
  'updates',
  'app-lock',
  /** Start processes on the machine: MCP servers over stdio. */
  'processes',
  /** Listen on the machine's network: mock services and their recording proxy. */
  'listen',
  /** Open more than one window of the app. */
  'windows',
  /** Sign in to and manage server accounts in this window. */
  'accounts',
  /** Show secret values in this window. */
  'reveal-secrets',
] as const;

/** What a platform can do; a host switches features off when the platform lacks one. */
export type Capability = (typeof ALL_CAPABILITIES)[number];

/**
 * The area switches a missing capability turns off (`app.areas`): without `ssh` the SSH area, without
 * `pty` the local terminal. The host resolves areas with it; Settings → Areas says why a row is off.
 */
export const AREA_CAPABILITIES: Readonly<Record<string, Capability>> = {
  ssh: 'ssh',
  'local-terminal': 'pty',
};
