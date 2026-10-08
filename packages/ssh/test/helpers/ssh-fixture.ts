import { generateKeyPairSync } from 'node:crypto';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import ssh2 from 'ssh2';
import type { Connection } from 'ssh2';
import { fingerprintOf, keyTypeOf } from '../../src/known-hosts.js';
import type { KnownHostEntry } from '../../src/known-hosts.js';

// ssh2 is CommonJS and Node's ESM loader finds only some of its named exports (not `Server` or `utils`), so
// the e2e runner, which loads this file natively, needs the default import. Vitest accepts either.
const { Server, utils } = ssh2;

export interface SshFixture {
  readonly port: number;
  readonly hostKey: KnownHostEntry;
  lastResize?: { cols: number; rows: number };
  close(): Promise<void>;
}

/**
 * An in-process ssh2 server on 127.0.0.1: password auth, a shell that echoes every byte and exits with
 * code N on an `exit N` line (ended by a newline, or by the carriage return a terminal's Enter key sends), and (optionally) direct-tcpip forwarding so it can act as a jump host.
 */
export async function startSshFixture(options: {
  password: { user: string; password: string };
  allowForwardOut?: boolean;
}): Promise<SshFixture> {
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
  const fixture: SshFixture = {
    port: 0,
    hostKey: { host: '', keyType: keyTypeOf(publicBlob), fingerprint: fingerprintOf(publicBlob) },
    close: async () => {
      for (const client of clients) client.end();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };

  const server = new Server({ hostKeys: [privateKey] }, (client) => {
    clients.add(client);
    client.on('close', () => clients.delete(client));
    client.on('error', () => undefined);
    client.on('authentication', (ctx) => {
      if (
        ctx.method === 'password' &&
        ctx.username === options.password.user &&
        ctx.password === options.password.password
      ) {
        ctx.accept();
      } else {
        ctx.reject(['password']);
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
