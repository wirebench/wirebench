import net from 'node:net';
import type { Duplex } from 'node:stream';
import type { Client, ClientChannel, TcpConnectionDetails } from 'ssh2';
import { dialChain } from './dial.js';
import type { DialOptions, DialledChain } from './dial.js';
import { SshModelError } from './errors.js';
import type { ForwardRule } from './resolve.js';
import { createSocks5Parser, socks5Reply } from './socks5.js';

export type ForwardStatus =
  | { readonly state: 'starting' }
  | {
      readonly state: 'running';
      readonly listening: { readonly address: string; readonly port: number };
      readonly connections: number;
      readonly lastError?: string;
    }
  | { readonly state: 'reconnecting'; readonly attempt: number; readonly nextInMs: number }
  | {
      readonly state: 'failed';
      readonly error: { code: string; message: string; details?: Record<string, unknown> };
    }
  | { readonly state: 'stopped' };

export interface ForwardConnectionOptions {
  /** Tests inject a fake dialler and timers. */
  readonly dial?: typeof dialChain;
  readonly setTimeout?: typeof setTimeout;
}

export interface ForwardConnection {
  /** Binds first (a clash refuses before any network), dials on the first start, then opens the rule. */
  start(rule: ForwardRule, options?: { readonly port?: number }): Promise<void>;
  stop(ruleId: string): Promise<void>;
  /** Stops every rule and ends the chain; idempotent. */
  close(): Promise<void>;
  onStatus(listener: (ruleId: string, status: ForwardStatus) => void): () => void;
}

/** ssh-forward-port-in-use {address,port} · ssh-forward-bind-failed {address,port,errno} · ssh-forward-refused · ssh-forward-gave-up */
export class ForwardError extends SshModelError {}

interface Running {
  readonly rule: ForwardRule;
  /** The port asked for: the rule's, or the one `start` was given. */
  readonly port: number;
  /** Local and dynamic rules' listener on this machine. */
  server?: net.Server;
  /** The port listening, here (local, dynamic) or on the host (remote), once known. */
  boundPort?: number;
  readonly sockets: Set<Duplex>;
  lastError?: string;
  status: ForwardStatus;
}

function errorOf(error: unknown): { code: string; message: string; details?: Record<string, unknown> } {
  if (error instanceof SshModelError)
    return { code: error.code, message: error.message, details: { ...error.details } };
  return { code: 'ssh-connect-failed', message: error instanceof Error ? error.message : String(error) };
}

function bindError(error: NodeJS.ErrnoException, address: string, port: number): ForwardError {
  if (error.code === 'EADDRINUSE') {
    return new ForwardError('ssh-forward-port-in-use', `${address}:${port} is already in use`, { address, port });
  }
  return new ForwardError('ssh-forward-bind-failed', `cannot listen on ${address}:${port} (${error.code})`, {
    address,
    port,
    errno: error.code,
  });
}

function listen(server: net.Server, address: string, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException): void => reject(bindError(error, address, port));
    server.once('error', onError);
    server.listen({ host: address, port, exclusive: true }, () => {
      server.removeListener('error', onError);
      resolve((server.address() as net.AddressInfo).port);
    });
  });
}

/** Pipes two streams both ways and tears both down when either ends. */
function join(a: Duplex, b: Duplex): void {
  const teardown = (): void => {
    a.destroy();
    b.destroy();
  };
  a.on('error', teardown);
  b.on('error', teardown);
  a.on('close', teardown);
  b.on('close', teardown);
  a.pipe(b).pipe(a);
}

function forwardOut(client: Client, socket: net.Socket, host: string, port: number): Promise<ClientChannel> {
  return new Promise((resolve, reject) =>
    client.forwardOut(socket.remoteAddress ?? '127.0.0.1', socket.remotePort ?? 0, host, port, (error, channel) =>
      error ? reject(error) : resolve(channel),
    ),
  );
}

/** One host's forwards over one chain, dialled on the first start and ended with the last stop. */
export function openForwardConnection(options: DialOptions & ForwardConnectionOptions): ForwardConnection {
  const dial = options.dial ?? dialChain;
  const rules = new Map<string, Running>();
  const listeners = new Set<(ruleId: string, status: ForwardStatus) => void>();
  let chain: DialledChain | undefined;
  let dialling: Promise<DialledChain> | undefined;

  const emit = (id: string, status: ForwardStatus): void => {
    for (const listener of listeners) listener(id, status);
  };
  const setStatus = (running: Running, status: ForwardStatus): void => {
    running.status = status;
    emit(running.rule.id, status);
  };
  const isCurrent = (running: Running): boolean => rules.get(running.rule.id) === running;
  const runningStatus = (running: Running): ForwardStatus => ({
    state: 'running',
    listening: { address: running.rule.bind, port: running.boundPort ?? running.port },
    connections: running.sockets.size,
    ...(running.lastError === undefined ? {} : { lastError: running.lastError }),
  });
  const refresh = (running: Running): void => {
    if (isCurrent(running) && running.status.state === 'running') setStatus(running, runningStatus(running));
  };
  /** Counts a socket while it is open and reports the count. */
  const track = (running: Running, socket: Duplex): void => {
    running.sockets.add(socket);
    socket.once('close', () => {
      running.sockets.delete(socket);
      refresh(running);
    });
    refresh(running);
  };
  const recordError = (running: Running, message: string): void => {
    running.lastError = message;
    refresh(running);
  };

  const onLocal = (running: Running, socket: net.Socket): void => {
    socket.on('error', () => undefined);
    const client = chain?.client;
    const target = running.rule.target;
    if (client === undefined || target === undefined || running.status.state !== 'running') {
      socket.destroy();
      return;
    }
    track(running, socket);
    forwardOut(client, socket, target.host, target.port).then(
      (channel) => join(socket, channel),
      (error: Error) => {
        socket.destroy();
        recordError(running, error.message);
      },
    );
  };

  const onDynamic = (running: Running, socket: net.Socket): void => {
    socket.on('error', () => undefined);
    if (chain === undefined || running.status.state !== 'running') {
      socket.destroy();
      return;
    }
    track(running, socket);
    const parser = createSocks5Parser();
    const onData = (chunk: Buffer): void => {
      let step = parser.push(chunk);
      while (step.kind === 'reply' && !step.close) {
        socket.write(step.bytes);
        step = parser.push(new Uint8Array(0));
      }
      if (step.kind === 'need-more') return;
      socket.removeListener('data', onData);
      if (step.kind === 'reply') {
        socket.end(step.bytes);
        return;
      }
      socket.pause();
      const client = chain?.client;
      if (client === undefined) {
        socket.end(socks5Reply(0x04));
        return;
      }
      const { host, port, rest } = step;
      forwardOut(client, socket, host, port).then(
        (channel) => {
          socket.write(socks5Reply(0x00));
          if (rest.length > 0) channel.write(rest);
          join(socket, channel);
          socket.resume();
        },
        (error: Error & { reason?: number }) => {
          // Reason 2 is SSH_OPEN_CONNECT_FAILED: the host could not reach the destination. Any other reason
          // (forwarding prohibited, no channels left) is the host refusing.
          socket.end(socks5Reply(error.reason === 2 ? 0x04 : 0x05));
          recordError(running, error.message);
        },
      );
    };
    socket.on('data', onData);
  };

  const onTcpConnection = (details: TcpConnectionDetails, accept: () => ClientChannel, reject: () => void): void => {
    const running = [...rules.values()].find(
      (r) => r.rule.type === 'remote' && r.status.state === 'running' && r.boundPort === details.destPort,
    );
    const target = running?.rule.target;
    if (running === undefined || target === undefined) {
      reject();
      return;
    }
    const channel = accept();
    const out = net.connect(target.port, target.host);
    track(running, channel);
    out.on('error', (error) => recordError(running, error.message));
    join(channel, out);
  };

  const requestRemote = (client: Client, running: Running): Promise<number> =>
    new Promise((resolve, reject) =>
      client.forwardIn(running.rule.bind, running.port, (error, port) =>
        error
          ? reject(
              new ForwardError(
                'ssh-forward-refused',
                `the host refused to listen on ${running.rule.bind}:${running.port}: ${error.message}`,
                { address: running.rule.bind, port: running.port },
              ),
            )
          : resolve(port || running.port),
      ),
    );

  const ensureChain = (): Promise<DialledChain> => {
    if (chain) return Promise.resolve(chain);
    dialling ??= dial({ hops: options.hops, verifyHostKey: options.verifyHostKey })
      .then((dialled) => {
        dialled.client.on('tcp connection', onTcpConnection);
        chain = dialled;
        return dialled;
      })
      .finally(() => {
        dialling = undefined;
      });
    return dialling;
  };

  const endChainIfIdle = (): void => {
    if (rules.size > 0 || chain === undefined) return;
    chain.endAll();
    chain = undefined;
  };

  /** Frees everything a rule holds here; the remote listener is cancelled by the caller. */
  const release = (running: Running): void => {
    for (const socket of running.sockets) socket.destroy();
    running.sockets.clear();
    running.server?.close();
  };

  const stop = async (ruleId: string): Promise<void> => {
    const running = rules.get(ruleId);
    if (running === undefined) return;
    rules.delete(ruleId);
    release(running);
    const client = chain?.client;
    if (running.rule.type === 'remote' && client !== undefined && running.boundPort !== undefined) {
      const port = running.boundPort;
      await new Promise<void>((resolve) => {
        try {
          client.unforwardIn(running.rule.bind, port, () => resolve());
        } catch {
          resolve();
        }
      });
    }
    setStatus(running, { state: 'stopped' });
    endChainIfIdle();
  };

  return {
    async start(rule, startOptions) {
      if (rules.has(rule.id)) {
        throw new ForwardError('ssh-forward-invalid', `${rule.id} is already started`, { id: rule.id });
      }
      const running: Running = {
        rule,
        port: startOptions?.port ?? rule.port,
        sockets: new Set(),
        status: { state: 'starting' },
      };
      rules.set(rule.id, running);
      emit(rule.id, running.status);
      try {
        if (rule.type !== 'remote') {
          const server = net.createServer((socket) =>
            rule.type === 'local' ? onLocal(running, socket) : onDynamic(running, socket),
          );
          running.server = server;
          running.boundPort = await listen(server, rule.bind, running.port);
        }
        const dialled = await ensureChain();
        if (!isCurrent(running)) return;
        if (rule.type === 'remote') running.boundPort = await requestRemote(dialled.client, running);
        if (!isCurrent(running)) return;
        setStatus(running, runningStatus(running));
      } catch (error) {
        if (isCurrent(running)) {
          rules.delete(rule.id);
          release(running);
          setStatus(running, { state: 'failed', error: errorOf(error) });
          endChainIfIdle();
        }
        throw error;
      }
    },
    stop,
    async close() {
      await Promise.all([...rules.keys()].map((id) => stop(id)));
      endChainIfIdle();
    },
    onStatus(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
