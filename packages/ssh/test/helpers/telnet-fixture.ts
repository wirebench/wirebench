import net from 'node:net';
import type { AddressInfo, Socket } from 'node:net';

const IAC = 255;
const DONT = 254;
const DO = 253;
const WONT = 252;
const WILL = 251;
const SB = 250;
const SE = 240;
const TTYPE = 24;
const NAWS = 31;
const ECHO = 1;
const SGA = 3;

/** What the client said during negotiation, per connection. */
export interface TelnetFixtureClient {
  /** The terminal type it sent (`SB TTYPE IS`). */
  terminalType?: string;
  /** Every window size it sent (`SB NAWS`), in order. */
  readonly sizes: Array<{ cols: number; rows: number }>;
  /** Every `WILL`/`WONT`/`DO`/`DONT` it sent, as `[verb, option]`. */
  readonly negotiation: Array<[number, number]>;
  /** Lines it sent, each without its CR LF, the password included. */
  readonly lines: string[];
}

export interface TelnetFixture {
  readonly port: number;
  readonly clients: TelnetFixtureClient[];
  close(): Promise<void>;
}

export interface TelnetFixtureOptions {
  /** Asks for these at `login:` and `Password:`; without it the shell prompt comes at once. */
  readonly login?: { readonly user: string; readonly password: string };
}

/**
 * A Telnet server for tests (#425): asks for the terminal type and window size, offers to echo and to
 * suppress go-ahead, then (with `login`) a `login:` and a `Password:` prompt, then a `$ ` shell where a line is
 * answered `you said: <line>` and `exit` hangs up. Echoes what is typed except the password.
 */
export async function startTelnetFixture(options: TelnetFixtureOptions = {}): Promise<TelnetFixture> {
  const clients: TelnetFixtureClient[] = [];
  const sockets = new Set<Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);
    const client: TelnetFixtureClient = { sizes: [], negotiation: [], lines: [] };
    clients.push(client);
    let stage: 'user' | 'password' | 'shell' = options.login === undefined ? 'shell' : 'user';
    let user = '';
    let line = '';
    let state: 'data' | 'iac' | 'verb' | 'sb' | 'sb-iac' = 'data';
    let verb = 0;
    let sub: number[] = [];
    let skipLf = false;
    const say = (text: string): void => {
      socket.write(Buffer.from(text, 'utf8'));
    };
    const prompt = (): void => {
      say(stage === 'user' ? 'login: ' : stage === 'password' ? 'Password: ' : '$ ');
    };
    const onLine = (text: string): void => {
      client.lines.push(text);
      say('\r\n');
      if (stage === 'user') {
        user = text;
        stage = 'password';
      } else if (stage === 'password') {
        if (user === options.login?.user && text === options.login.password) {
          say('Welcome\r\n');
          stage = 'shell';
        } else {
          say('Login incorrect\r\n');
          stage = 'user';
        }
      } else if (text === 'exit') {
        socket.end();
        return;
      } else {
        say(`you said: ${text}\r\n`);
      }
      prompt();
    };
    socket.on('data', (chunk: Buffer) => {
      for (const byte of chunk) {
        if (state === 'data') {
          if (byte === IAC) state = 'iac';
          else if (skipLf && (byte === 10 || byte === 0)) skipLf = false;
          else if (byte === 13) {
            skipLf = true;
            const text = line;
            line = '';
            onLine(text);
          } else {
            skipLf = false;
            line += String.fromCharCode(byte);
            if (stage !== 'password') socket.write(Buffer.from([byte]));
          }
        } else if (state === 'iac') {
          if (byte === IAC) {
            line += String.fromCharCode(IAC);
            state = 'data';
          } else if (byte === WILL || byte === WONT || byte === DO || byte === DONT) {
            verb = byte;
            state = 'verb';
          } else if (byte === SB) {
            sub = [];
            state = 'sb';
          } else state = 'data';
        } else if (state === 'verb') {
          client.negotiation.push([verb, byte]);
          if (verb === WILL && byte === TTYPE) socket.write(Buffer.from([IAC, SB, TTYPE, 1, IAC, SE]));
          state = 'data';
        } else if (state === 'sb') {
          if (byte === IAC) state = 'sb-iac';
          else sub.push(byte);
        } else {
          if (byte === IAC) {
            sub.push(IAC);
            state = 'sb';
            continue;
          }
          if (sub[0] === TTYPE && sub[1] === 0) client.terminalType = Buffer.from(sub.slice(2)).toString('ascii');
          if (sub[0] === NAWS && sub.length === 5) {
            const [, c1 = 0, c0 = 0, r1 = 0, r0 = 0] = sub;
            client.sizes.push({ cols: (c1 << 8) | c0, rows: (r1 << 8) | r0 });
          }
          sub = [];
          state = 'data';
        }
      }
    });
    socket.write(Buffer.from([IAC, DO, TTYPE, IAC, DO, NAWS, IAC, WILL, ECHO, IAC, WILL, SGA]));
    prompt();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as AddressInfo).port,
    clients,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => {
          resolve();
        });
      }),
  };
}
