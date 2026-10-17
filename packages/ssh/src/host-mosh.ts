import { z } from 'zod';

/**
 * How a host reaches its shell: SSH all the way, SSH to start a mosh server and UDP after it (#419), or Telnet
 * (#425), plain text, straight or through a channel from an SSH jump host, or a serial console on this machine
 * (#426).
 */
export type SessionProtocol = 'ssh' | 'mosh' | 'telnet' | 'serial';

/** The protocols whose target signs in over SSH: only they need a user and a way in. */
export const signsInOverSsh = (protocol: SessionProtocol): boolean => protocol === 'ssh' || protocol === 'mosh';

/** Telnet's port when a host sets none. */
export const TELNET_PORT = 23;

/** `ssh.mosh` on a host or group: taken whole from the nearest level that sets it. */
export interface MoshSettings {
  /** The remote `mosh-server` command; `mosh-server` on the remote PATH when unset. */
  server?: string | undefined;
  /** The UDP port or range the server binds, mosh's own `N` or `LOW:HIGH`; the server picks when unset. */
  ports?: string | undefined;
}

const PORTS = /^(\d{1,5})(?::(\d{1,5}))?$/;

/** `[low, high]` for a valid `N` or `LOW:HIGH`, else undefined. */
export function parseMoshPorts(text: string): readonly [number, number] | undefined {
  const match = PORTS.exec(text);
  if (!match) return undefined;
  const low = Number(match[1]);
  const high = match[2] === undefined ? low : Number(match[2]);
  if (low < 1 || high > 65535 || low > high) return undefined;
  return [low, high];
}

export const protocolSchema = z.enum(['ssh', 'mosh', 'telnet', 'serial']).optional();

/** Matches a control character: a server command holding one is refused, not run. */
const CONTROL = /[\u0000-\u001f\u007f]/;

export const moshSchema = z
  .strictObject({
    server: z
      .string()
      .trim()
      .min(1)
      .refine((s) => !CONTROL.test(s), 'must not hold control characters')
      .optional(),
    ports: z
      .string()
      .refine((p) => parseMoshPorts(p) !== undefined, 'must be a port or LOW:HIGH, 1–65535, LOW no higher than HIGH')
      .optional(),
  })
  .transform((m): MoshSettings => {
    const out: MoshSettings = {};
    if (m.server !== undefined) out.server = m.server;
    if (m.ports !== undefined) out.ports = m.ports;
    return out;
  })
  .optional();
