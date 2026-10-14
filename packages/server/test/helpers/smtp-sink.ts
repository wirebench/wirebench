/**
 * An in-process SMTP sink for the email alert tests (scheduled-runs spec §3.4): plain or implicit TLS
 * on 127.0.0.1, an OS-assigned port. It speaks just enough ESMTP for one client — EHLO, AUTH PLAIN,
 * MAIL, RCPT, DATA, RSET, QUIT — and records each message with its envelope and the credentials it
 * was given. `reject` answers DATA's end with a permanent failure instead.
 */
import { createServer as createNetServer, type Server, type Socket } from 'node:net';
import { createServer as createTlsServer } from 'node:tls';
import type { TlsIdentity } from './forward-receivers.js';

export interface SunkMessage {
  readonly from: string;
  readonly to: readonly string[];
  /** The message as sent, dot-unstuffed, CRLF line ends. */
  readonly data: string;
  /** `user:pass` from AUTH PLAIN, when the client logged in. */
  readonly auth?: string;
}

export interface SmtpSink {
  readonly port: number;
  readonly messages: SunkMessage[];
  close(): Promise<void>;
}

export async function smtpSink(options: { tls?: TlsIdentity; reject?: boolean } = {}): Promise<SmtpSink> {
  const messages: SunkMessage[] = [];
  const sockets: Socket[] = [];
  const onConnection = (socket: Socket) => {
    sockets.push(socket);
    socket.on('error', () => undefined);
    socket.setEncoding('utf8');
    let buffer = '';
    let auth: string | undefined;
    let from = '';
    let to: string[] = [];
    let data: string[] | undefined;
    let awaitingAuth = false;
    const reply = (line: string) => socket.write(`${line}\r\n`);
    const login = (encoded: string) => {
      const [, user, pass] = Buffer.from(encoded, 'base64').toString('utf8').split('\0');
      auth = `${user ?? ''}:${pass ?? ''}`;
      reply('235 2.7.0 Authentication successful');
    };
    const onLine = (line: string) => {
      if (data !== undefined) {
        if (line === '.') {
          if (options.reject === true) reply('554 5.7.1 Message rejected');
          else {
            messages.push({ from, to, data: `${data.join('\r\n')}\r\n`, ...(auth !== undefined ? { auth } : {}) });
            reply('250 2.0.0 Queued');
          }
          data = undefined;
          from = '';
          to = [];
        } else data.push(line.startsWith('..') ? line.slice(1) : line);
        return;
      }
      if (awaitingAuth) {
        awaitingAuth = false;
        login(line);
        return;
      }
      const verb = line.slice(0, 4).toUpperCase();
      if (verb === 'EHLO' || verb === 'HELO') {
        socket.write('250-sink.test\r\n250-AUTH PLAIN\r\n250 8BITMIME\r\n');
      } else if (verb === 'AUTH') {
        const [, mechanism, initial] = line.split(' ');
        if (mechanism?.toUpperCase() !== 'PLAIN') reply('504 5.5.4 Unrecognized authentication type');
        else if (initial !== undefined) login(initial);
        else {
          awaitingAuth = true;
          reply('334 ');
        }
      } else if (verb === 'MAIL') {
        from = /<([^>]*)>/.exec(line)?.[1] ?? '';
        reply('250 2.1.0 Ok');
      } else if (verb === 'RCPT') {
        to.push(/<([^>]*)>/.exec(line)?.[1] ?? '');
        reply('250 2.1.5 Ok');
      } else if (verb === 'DATA') {
        data = [];
        reply('354 End data with <CR><LF>.<CR><LF>');
      } else if (verb === 'RSET') {
        from = '';
        to = [];
        reply('250 2.0.0 Ok');
      } else if (verb === 'QUIT') {
        reply('221 2.0.0 Bye');
        socket.end();
      } else reply('502 5.5.2 Command not recognized');
    };
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      for (let end = buffer.indexOf('\r\n'); end >= 0; end = buffer.indexOf('\r\n')) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        onLine(line);
      }
    });
    reply('220 sink.test ESMTP');
  };
  const server: Server =
    options.tls === undefined
      ? createNetServer(onConnection)
      : createTlsServer({ cert: options.tls.certPem, key: options.tls.keyPem }, onConnection);
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve(typeof address === 'object' && address !== null ? address.port : 0);
    });
  });
  return {
    port,
    messages,
    close: () => {
      for (const socket of sockets) socket.destroy();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
