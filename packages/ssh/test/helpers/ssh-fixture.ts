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
  lastResize?: { cols: number; rows: number };
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
  const fixture: SshFixture = {
    port: 0,
    hostKey: { host: '', keyType: keyTypeOf(publicBlob), fingerprint: fingerprintOf(publicBlob) },
    drop: () => {
      for (const client of clients) (client as unknown as { _sock: net.Socket })._sock.resetAndDestroy();
    },
    close: async () => {
      for (const client of clients) client.end();
      for (const socket of sockets) socket.destroy();
      for (const child of children) child.kill();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };

  const server = new Server({ hostKeys: [privateKey] }, (client) => {
    clients.add(client);
    client.on('close', () => clients.delete(client));
    client.on('error', () => undefined);
    client.on('authentication', (ctx) => {
      const methods: ssh2.AuthenticationType[] = allowedKey === undefined ? ['password'] : ['password', 'publickey'];
      if (
        ctx.method === 'password' &&
        ctx.username === options.password.user &&
        ctx.password === options.password.password
      ) {
        ctx.accept();
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
        session.on('window-change', (accept, _reject, info) => {
          fixture.lastResize = { cols: info.cols, rows: info.rows };
          accept?.();
        });
        // Runs nothing: stdout stays empty, as a refused exec channel's would, and the exit status is 0.
        session.on('exec', (accept) => {
          const stream = accept();
          stream.exit(0);
          stream.end();
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
    if (options.allowForwardOut) {
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

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return Object.assign(fixture, { port, hostKey: { ...fixture.hostKey, host: `127.0.0.1:${port}` } });
}
