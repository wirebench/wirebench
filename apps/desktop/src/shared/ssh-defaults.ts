/**
 * The SSH area's plain constants, free of zod: the renderer imports them eagerly, and a value import of
 * `ssh-wire.ts` would build zod schemas before `main.tsx` turns zod's JIT probe off (the renderer CSP
 * trap; `test/renderer-eager-imports.test.ts` guards it).
 */

/** What a setting resolves to when no host or group sets it; the resolver in `@wirebench/ssh` must agree (tested). */
export const SSH_DEFAULTS = { port: 22, keepAlive: 15, connectTimeout: 20 } as const;

export const SSH_SECRET_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The operating systems a host's icon can show. `linux` is a Linux the list does not name; a host
 * with nothing detected or chosen has no entry at all.
 */
export const SSH_OS_IDS = [
  'ubuntu',
  'debian',
  'rhel',
  'centos',
  'fedora',
  'rocky',
  'alma',
  'suse',
  'alpine',
  'arch',
  'amazon',
  'linux',
  'macos',
  'freebsd',
  'windows',
] as const;

/** At most this many `forward.state` events a second per forward for connection-count changes. */
export const FORWARD_EVENTS_PER_SECOND = 4;
