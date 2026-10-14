import { randomUUID } from 'node:crypto';
import type { Client, ClientChannel } from 'ssh2';
import { HopProgress } from './connect-progress.js';
import { SshConnectError, dialChain, hostOf } from './dial.js';
import type { DialOptions, HopCredentials } from './dial.js';

/** After `close()`, `onExit` still fires once with `{ code: null }`. */
export type OpenSessionOptions = DialOptions & {
  readonly cols: number;
  readonly rows: number;
  /**
   * Sent to the target as SSH `env` requests before the shell starts, values already resolved. No reply
   * is asked for: a server takes only the names its `AcceptEnv` allows and ignores the rest.
   */
  readonly env?: Readonly<Record<string, string>>;
};

/**
 * `on`: the target granted agent forwarding on the shell. `refused`: it was asked for and the server said no;
 * the shell opened without it. `off`: not asked for.
 */
export type AgentForwarding = 'on' | 'refused' | 'off';

export interface SshSession {
  readonly id: string;
  readonly agentForwarding: AgentForwarding;
  write(data: Uint8Array): void;
  resize(cols: number, rows: number): void;
  close(): void;
  /**
   * Runs one command on the same connection (a separate channel from the shell) and resolves with its
   * stdout. Never rejects: a failure or the timeout resolves to ''.
   */
  exec(command: string, timeoutMs: number): Promise<string>;
  onData(listener: (data: Uint8Array) => void): () => void;
  onExit(listener: (exit: SessionExit) => void): () => void;
}

/**
 * Why a session ended. `exit`: the shell reported an exit status or signal, or the server closed the
 * channel with the connection still up. `lost`: a hop's connection failed or went away first (reset,
 * timeout, keep-alive, a jump host's connection ending). `closed`: {@link SshSession.close}.
 */
export type SessionEndReason = 'exit' | 'lost' | 'closed';

export interface SessionExit {
  readonly code: number | null;
  readonly signal?: string;
  readonly reason: SessionEndReason;
}

/** ssh2's message when the server refuses `auth-agent-req@openssh.com`. */
const AGENT_REFUSED = /agent forwarding/i;

export async function openSession(options: OpenSessionOptions): Promise<SshSession> {
  const chain = await dialChain(options);
  try {
    const lastHop = options.hops[options.hops.length - 1] as HopCredentials;
    const progress = new HopProgress(options.onProgress, options.hops.length - 1, options.hops.length, hostOf(lastHop));
    progress.start('shell', 'xterm-256color');
    progress.log(`Opening a shell (xterm-256color, ${String(options.cols)}×${String(options.rows)})`);
    const env = options.env !== undefined && Object.keys(options.env).length > 0 ? { ...options.env } : undefined;
    const shell = (agentForward: boolean): Promise<ClientChannel> =>
      new Promise((resolve, reject) =>
        chain.client.shell(
          { term: 'xterm-256color', cols: options.cols, rows: options.rows },
          { ...(env === undefined ? {} : { env }), ...(agentForward ? { agentForward: true } : {}) },
          (error, ch) => (error ? reject(error) : resolve(ch)),
        ),
      );
    const failed = (error: Error): SshConnectError => {
      progress.log('The server would not open a shell');
      return new SshConnectError('ssh-connect-failed', `${hostOf(lastHop)}: ${error.message}`, {
        host: hostOf(lastHop),
        hop: options.hops.length - 1,
        reason: 'other',
        phase: 'shell',
      });
    };
    let forwarding: AgentForwarding = options.forwardAgent === undefined ? 'off' : 'on';
    let channel: ClientChannel;
    try {
      channel = await shell(forwarding === 'on');
    } catch (error) {
      // ssh2 closes the channel when the server refuses forwarding; like OpenSSH, the shell opens without it.
      if (forwarding !== 'on' || !AGENT_REFUSED.test((error as Error).message)) throw failed(error as Error);
      forwarding = 'refused';
      progress.log('The server refused agent forwarding; opening the shell without it');
      channel = await shell(false).catch((again: unknown) => Promise.reject(failed(again as Error)));
    }
    progress.log('Shell open');
    progress.done('shell', 'xterm-256color');
    return wrap(channel, chain.client, () => chain.endAll(), chain, forwarding);
  } catch (error) {
    chain.endAll();
    throw error;
  }
}

function wrap(
  channel: ClientChannel,
  client: Client,
  endAll: () => void,
  link: { readonly lost: boolean },
  agentForwarding: AgentForwarding,
): SshSession {
  const dataListeners = new Set<(data: Uint8Array) => void>();
  const exitListeners = new Set<(exit: SessionExit) => void>();
  let exited = false;
  let closed = false;
  let closedHere = false;
  const exit = (code: number | null, reason: SessionEndReason, signal?: string): void => {
    if (exited) return;
    exited = true;
    closed = true;
    const why: SessionEndReason = closedHere ? 'closed' : reason;
    for (const listener of exitListeners) listener({ code, ...(signal ? { signal } : {}), reason: why });
    endAll();
  };
  const ended = (): SessionEndReason => (link.lost ? 'lost' : 'exit');
  channel.on('data', (data: Buffer) => {
    for (const listener of dataListeners) listener(data);
  });
  channel.stderr.on('data', (data: Buffer) => {
    for (const listener of dataListeners) listener(data);
  });
  channel.on('exit', (code: number | null, signal?: string) => exit(code, 'exit', signal));
  channel.on('close', () => exit(null, ended()));
  channel.on('error', () => exit(null, 'lost'));
  return {
    id: randomUUID(),
    agentForwarding,
    write: (data) => {
      if (!closed) channel.write(Buffer.from(data));
    },
    resize: (cols, rows) => {
      if (!closed) channel.setWindow(rows, cols, 0, 0);
    },
    close: () => {
      closed = true;
      closedHere = true;
      channel.end();
      endAll();
    },
    exec: (command, timeoutMs) =>
      new Promise<string>((resolve) => {
        let out = '';
        let settled = false;
        let stream: ClientChannel | undefined;
        const done = (): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          stream?.close();
          resolve(out);
        };
        const timer = setTimeout(() => {
          out = '';
          done();
        }, timeoutMs);
        if (closed) return done();
        try {
          client.exec(command, (error, ch) => {
            if (error) return done();
            stream = ch;
            if (settled) return ch.close();
            ch.on('data', (data: Buffer) => {
              out += data.toString('utf8');
            });
            ch.on('close', done);
            ch.on('error', () => {
              out = '';
              done();
            });
          });
        } catch {
          done();
        }
      }),
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
