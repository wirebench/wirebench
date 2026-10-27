import { randomUUID } from 'node:crypto';
import { HopProgress, bootstrapMosh, hostOf } from '@wirebench/ssh';
import type { HopCredentials, MoshSettings, OpenSessionOptions, SessionExit, SshSession } from '@wirebench/ssh';
import { WirebenchError } from '@wirebench/engine';
import type { LocalPty, LocalPtySpawn } from './local-terminal-service.js';
import { moshClientEnv } from './mosh-client.js';

export type OpenMoshOptions = OpenSessionOptions & { readonly mosh?: MoshSettings | undefined };

export interface MoshSessionDeps {
  /** The installed `mosh-client`, looked up per connect so an install takes effect without a restart. */
  readonly findClient: () => string | undefined;
  /** Loads the native pty binding (the local terminal's, #410). */
  readonly load: () => Promise<LocalPtySpawn>;
  /** The target's address as this machine resolves it: UDP goes straight there. */
  readonly lookup: (address: string) => Promise<string>;
  /** The environment the client starts from (the local shell's). */
  readonly env: () => Record<string, string>;
  readonly home: string;
  readonly platform: NodeJS.Platform;
  /** Tests stand in for the SSH half. */
  readonly bootstrap?: typeof bootstrapMosh;
}

/**
 * Opens a Mosh session (#419): starts `mosh-server` over SSH, then runs the installed `mosh-client` in a
 * pseudo-terminal against it. The answer is an {@link SshSession}, so the terminal tab, the masker, logs
 * and reconnect treat it as any other.
 *
 * @throws WirebenchError `mosh-client-missing` | `mosh-unavailable` | `mosh-unreachable` | `mosh-client-failed`,
 *   and every refusal of the SSH half (`mosh-server-missing`, `mosh-bootstrap-failed`, the dial's)
 */
export async function openMoshSession(deps: MoshSessionDeps, options: OpenMoshOptions): Promise<SshSession> {
  const client = deps.findClient();
  if (client === undefined) {
    throw new WirebenchError(
      'mosh-client-missing',
      'Mosh is not installed on this computer: install mosh (it provides mosh-client), or switch the host to SSH.',
    );
  }
  let spawn: LocalPtySpawn;
  try {
    spawn = await deps.load();
  } catch (error) {
    throw new WirebenchError(
      'mosh-unavailable',
      `Mosh sessions are not available on this machine: ${messageOf(error)}`,
    );
  }
  const target = options.hops[options.hops.length - 1] as HopCredentials;
  let ip: string;
  try {
    ip = await deps.lookup(target.address);
  } catch {
    throw new WirebenchError(
      'mosh-unreachable',
      `Mosh connects to ${target.address} directly over UDP, and that name does not resolve on this computer.`,
      { details: { host: target.address } },
    );
  }
  const endpoint = await (deps.bootstrap ?? bootstrapMosh)({
    hops: options.hops,
    verifyHostKey: options.verifyHostKey,
    ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
    ...(options.mosh === undefined ? {} : { mosh: options.mosh }),
    ...(options.env === undefined ? {} : { env: options.env }),
  });
  const progress = new HopProgress(options.onProgress, options.hops.length - 1, options.hops.length, hostOf(target));
  if (options.hops.length > 1) progress.log(`UDP goes straight to ${ip}, not through the jump host`);
  progress.log(`Starting mosh-client: UDP to ${ip}:${String(endpoint.port)}`);
  let pty: LocalPty;
  try {
    pty = spawn(client, [ip, String(endpoint.port)], {
      name: 'xterm-256color',
      cols: options.cols,
      rows: options.rows,
      cwd: deps.home,
      env: moshClientEnv(deps.env(), endpoint.key, deps.platform),
    });
  } catch (error) {
    progress.fail('mosh-client did not start');
    throw new WirebenchError('mosh-client-failed', `Could not start ${client}: ${messageOf(error)}`);
  }
  return wrapPty(pty);
}

/** A pty as an {@link SshSession}: its exit ends the session, a close here hangs it up. */
export function wrapPty(pty: LocalPty): SshSession {
  const dataListeners = new Set<(data: Uint8Array) => void>();
  const exitListeners = new Set<(exit: SessionExit) => void>();
  let closed = false;
  let exited = false;
  const exit = (exitInfo: SessionExit): void => {
    if (exited) return;
    exited = true;
    closed = true;
    for (const listener of exitListeners) listener(exitInfo);
  };
  pty.onData((text) => {
    const data = Buffer.from(text, 'utf8');
    for (const listener of dataListeners) listener(data);
  });
  pty.onExit(({ exitCode }) => {
    exit({ code: exitCode, reason: 'exit' });
  });
  return {
    id: randomUUID(),
    agentForwarding: 'off',
    write: (data) => {
      if (!closed) pty.write(Buffer.from(data).toString('utf8'));
    },
    resize: (cols, rows) => {
      if (!closed) pty.resize(cols, rows);
    },
    close: () => {
      if (closed) return;
      closed = true;
      // A hang-up makes mosh-client shut the session down on the server too.
      try {
        pty.kill();
      } catch {
        // already gone
      }
      exit({ code: null, reason: 'closed' });
    },
    // The SSH connection ended once the server started: there is no channel to run a command on.
    exec: () => Promise.resolve(''),
    onData: (listener) => {
      dataListeners.add(listener);
      return () => {
        dataListeners.delete(listener);
      };
    },
    onExit: (listener) => {
      exitListeners.add(listener);
      return () => {
        exitListeners.delete(listener);
      };
    },
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
