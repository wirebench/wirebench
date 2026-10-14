import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { existsSync } from 'node:fs';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import ssh2 from 'ssh2';
import type { Connection } from 'ssh2';
import { fingerprintOf, keyTypeOf } from '../../src/known-hosts.js';
import type { KnownHostEntry } from '../../src/known-hosts.js';

// ssh2 is CommonJS and Node's ESM loader finds only some of its named exports (not `Server` or `utils`), so
// the e2e runner, which loads this file natively, needs the default import. Vitest accepts either.
const { Server, utils } = ssh2;

const SFTP_SERVER_PATHS = [
  '/usr/lib/openssh/sftp-server',
  '/usr/libexec/openssh/sftp-server',
  '/usr/libexec/sftp-server',
];
let sftpServer: { path: string; startDir: boolean } | null | undefined;

function findSftpServer(): { path: string; startDir: boolean } | null {
  if (sftpServer !== undefined) return sftpServer;
  const path = SFTP_SERVER_PATHS.find((candidate) => existsSync(candidate));
  if (path === undefined) return (sftpServer = null);
  // `-d` (start directory) came in OpenSSH 6.2; without it the server starts in its working directory.
  const help = spawnSync(path, ['-h'], { encoding: 'utf8' });
  return (sftpServer = { path, startDir: `${help.stdout}${help.stderr}`.includes('-d ') });
}

/** The OpenSSH `sftp-server` the fixture's SFTP subsystem runs, or undefined where none is installed. */
export function sftpServerPath(): string | undefined {
  return findSftpServer()?.path;
}

export interface SshFixture {
  readonly port: number;
  readonly hostKey: KnownHostEntry;
  /** The host key as a known_hosts line has it after the names: `ssh-rsa AAAA…`. */
  readonly hostPublicKey: string;
  lastResize?: { cols: number; rows: number };
  /** SSH connections the server has accepted so far. */
  readonly connections: number;
  /** Every `tcpip-forward` global request granted, in order, and whether it was cancelled since. */
  readonly remoteForwards: { bindAddr: string; bindPort: number; cancelled: boolean }[];
  /** Every `env` request on a session channel, in order, and whether it was accepted. */
  readonly envRequests: { key: string; val: string; accepted: boolean }[];
  /** Every `auth-agent-req@openssh.com` on a session channel, in order, and whether it was granted. */
  readonly agentRequests: { accepted: boolean }[];
  /** Resets every client's TCP connection, as a network that went away would: no exit status, no disconnect. */
  drop(): void;
  close(): Promise<void>;
}

/**
 * An in-process ssh2 server on 127.0.0.1: password auth (and, optionally, one public key), a shell that echoes every byte and exits with
 * code N on an `exit N` line (ended by a newline, or by the carriage return a terminal's Enter key sends), and (optionally) direct-tcpip forwarding so it can act as a jump host.
 */
export async function startSshFixture(options: {
  password: { user: string; password: string };
  /** Also accept public-key auth for `user` with the public half of `privateKey` (a PEM). */
  key?: { user: string; privateKey: string };
  allowForwardOut?: boolean;
  /**
   * With a root, the `sftp` subsystem runs OpenSSH's `sftp-server` starting in that folder (it is not a
   * chroot); `'refuse'` rejects the subsystem. Without it the subsystem is refused too.
   */
  sftp?: { root: string } | 'refuse';
  /** Runs exec requests under `/bin/sh` with HOME (and the working folder) set to `home`; without it they do nothing. */
  exec?: { home: string };
  /** Listen here instead of on a free port, so a test can bring a closed fixture back at the same address. */
  port?: number;
  /** Grant `tcpip-forward` (a listener on this side for each request) and `cancel-tcpip-forward`. */
  tcpipForward?: boolean;
  /** Refuse direct-tcpip channels and `tcpip-forward` requests, as `AllowTcpForwarding no` would. */
  refuseForward?: boolean;
  /** Accept `env` requests only for these names, as `AcceptEnv` would; without it every name is accepted. */
  acceptEnv?: readonly string[];
  /** Refuse agent forwarding requests, as `AllowAgentForwarding no` would; without it they are granted. */
  refuseAgentForwarding?: boolean;
  /** Hold every sign-in this long before accepting it, so a test can act while the client connects. */
  authDelayMs?: number;
}): Promise<SshFixture> {
  const sftp = options.sftp;
  const sftpBinary = typeof sftp === 'object' ? findSftpServer() : null;
  if (typeof sftp === 'object' && sftpBinary === null) throw new Error('no OpenSSH sftp-server is installed');
  const allowedKey = options.key === undefined ? undefined : utils.parseKey(options.key.privateKey);
  if (allowedKey instanceof Error) throw allowedKey;
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
  });
  const parsed = utils.parseKey(privateKey);
  if (parsed instanceof Error) throw parsed;
  const publicBlob = parsed.getPublicSSH();
  const clients = new Set<Connection>();
  const sockets = new Set<net.Socket>();
  const children = new Set<ChildProcess>();
  const forwardServers = new Set<net.Server>();
  let connections = 0;
  const fixture: SshFixture = {
    port: 0,
    get connections() {
      return connections;
    },
    remoteForwards: [],
    envRequests: [],
    agentRequests: [],
    hostKey: { host: '', keyType: keyTypeOf(publicBlob), fingerprint: fingerprintOf(publicBlob) },
    hostPublicKey: `${keyTypeOf(publicBlob)} ${publicBlob.toString('base64')}`,
    drop: () => {
      for (const client of clients) (client as unknown as { _sock: net.Socket })._sock.resetAndDestroy();
    },
    close: async () => {
      for (const client of clients) client.end();
      for (const socket of sockets) socket.destroy();
      for (const child of children) child.kill();
      for (const listener of forwardServers) listener.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };

  const server = new Server({ hostKeys: [privateKey] }, (client) => {
    clients.add(client);
    connections += 1;
    const remoteListeners = new Map<string, net.Server>();
    client.on('close', () => {
      clients.delete(client);
      for (const listener of remoteListeners.values()) listener.close();
    });
    client.on('error', () => undefined);
    client.on('authentication', (ctx) => {
      const methods: ssh2.AuthenticationType[] = allowedKey === undefined ? ['password'] : ['password', 'publickey'];
      if (
        ctx.method === 'password' &&
        ctx.username === options.password.user &&
        ctx.password === options.password.password
      ) {
        if (options.authDelayMs === undefined) ctx.accept();
        else setTimeout(() => ctx.accept(), options.authDelayMs);
      } else if (
        ctx.method === 'publickey' &&
        allowedKey !== undefined &&
        ctx.username === options.key?.user &&
        ctx.key.algo === allowedKey.type &&
        ctx.key.data.equals(allowedKey.getPublicSSH()) &&
        // Without a signature the client only asks whether the key would do.
        (ctx.signature === undefined || allowedKey.verify(ctx.blob as Buffer, ctx.signature, ctx.hashAlgo) === true)
      ) {
        ctx.accept();
      } else {
        ctx.reject(methods);
      }
    });
    client.on('ready', () => {
      client.on('session', (acceptSession) => {
        const session = acceptSession();
        session.on('pty', (accept, _reject, info) => {
          fixture.lastResize = { cols: info.cols, rows: info.rows };
          accept();
        });
        session.on('env', (accept, reject, info) => {
          const accepted = options.acceptEnv === undefined || options.acceptEnv.includes(info.key);
          fixture.envRequests.push({ key: info.key, val: info.val, accepted });
          if (accepted) accept?.();
          else reject?.();
        });
        session.on('auth-agent', (accept, reject) => {
          const accepted = options.refuseAgentForwarding !== true;
          fixture.agentRequests.push({ accepted });
          if (accepted) accept?.();
          else reject?.();
        });
        session.on('window-change', (accept, _reject, info) => {
          fixture.lastResize = { cols: info.cols, rows: info.rows };
          accept?.();
        });
        // Without `exec`, runs nothing: stdout stays empty, as a refused exec channel's would, and the exit
        // status is 0. With it, `/bin/sh -c` runs the command for real with HOME set to that folder.
        session.on('exec', (accept, _reject, info) => {
          const stream = accept();
          if (options.exec === undefined) {
            stream.exit(0);
            stream.end();
            return;
          }
          const child = spawn('/bin/sh', ['-c', info.command], {
            cwd: options.exec.home,
            env: { HOME: options.exec.home, PATH: process.env['PATH'] ?? '/usr/bin:/bin' },
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          children.add(child);
          child.stdout.on('data', (data: Buffer) => stream.write(data));
          child.stderr.on('data', (data: Buffer) => stream.stderr.write(data));
          child.on('error', () => stream.close());
          child.on('close', (code) => {
            children.delete(child);
            stream.exit(code ?? 1);
            stream.end();
          });
        });
        if (sftp !== undefined) {
          session.on('subsystem', (accept, reject, info) => {
            if (info.name !== 'sftp' || sftp === 'refuse' || sftpBinary === null) return reject();
            const stream = accept();
            const child = spawn(sftpBinary.path, sftpBinary.startDir ? ['-d', sftp.root] : [], {
              cwd: sftp.root,
              stdio: ['pipe', 'pipe', 'ignore'],
            });
            children.add(child);
            child.on('error', () => stream.close());
            child.on('exit', (code) => {
              children.delete(child);
              stream.exit(code ?? 0);
              stream.end();
            });
            stream.on('error', () => child.kill());
            stream.on('close', () => child.kill());
            // The child can exit with bytes still in flight; a write to its closed stdin is not a test failure.
            child.stdin.on('error', () => undefined);
            stream.pipe(child.stdin);
            child.stdout.pipe(stream);
          });
        }
        session.on('shell', (accept) => {
          const stream = accept();
          let line = '';
          stream.on('data', (data: Buffer) => {
            stream.write(data);
            line += data.toString();
            const match = /exit (\d+)[\r\n]/.exec(line);
            if (match) {
              stream.exit(Number(match[1]));
              stream.end();
            }
          });
        });
      });
    });
    if (options.tcpipForward || options.refuseForward) {
      client.on('request', (accept, reject, name, info) => {
        const key = `${info.bindAddr}:${info.bindPort}`;
        if (options.refuseForward || (name !== 'tcpip-forward' && name !== 'cancel-tcpip-forward')) {
          return reject?.();
        }
        if (name === 'cancel-tcpip-forward') {
          remoteListeners.get(key)?.close();
          remoteListeners.delete(key);
          const granted = fixture.remoteForwards.findLast(
            (f) => f.bindAddr === info.bindAddr && f.bindPort === info.bindPort,
          );
          if (granted) granted.cancelled = true;
          return accept?.();
        }
        const listener = net.createServer((socket) => {
          sockets.add(socket);
          socket.on('close', () => sockets.delete(socket));
          socket.on('error', () => undefined);
          const bound = (listener.address() as AddressInfo).port;
          client.forwardOut(
            info.bindAddr,
            bound,
            socket.remoteAddress ?? '127.0.0.1',
            socket.remotePort ?? 0,
            (error, stream) => {
              if (error) return socket.destroy();
              stream.on('error', () => socket.destroy());
              socket.pipe(stream).pipe(socket);
            },
          );
        });
        forwardServers.add(listener);
        listener.on('close', () => forwardServers.delete(listener));
        listener.once('error', () => reject?.());
        const host = info.bindAddr === 'localhost' || info.bindAddr === '' ? '127.0.0.1' : info.bindAddr;
        listener.listen(info.bindPort, host, () => {
          remoteListeners.set(key, listener);
          fixture.remoteForwards.push({ bindAddr: info.bindAddr, bindPort: info.bindPort, cancelled: false });
          accept?.((listener.address() as AddressInfo).port);
        });
      });
    }
    if (options.refuseForward) {
      client.on('tcpip', (_accept, reject) => reject());
    } else if (options.allowForwardOut) {
      client.on('tcpip', (accept, _reject, info) => {
        const stream = accept();
        const out = net.connect(info.destPort, info.destIP);
        sockets.add(out);
        out.on('close', () => sockets.delete(out));
        out.on('error', () => stream.close());
        stream.on('error', () => out.destroy());
        stream.pipe(out).pipe(stream);
      });
    }
  });

  await new Promise<void>((resolve) => server.listen(options.port ?? 0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return Object.assign(fixture, { port, hostKey: { ...fixture.hostKey, host: `127.0.0.1:${port}` } });
}
