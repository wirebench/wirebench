/**
 * Real sockets against a listening server (live-updates spec §11). The client is Node's global
 * WebSocket, which sends no `Origin` (spec assumption 4), just as the desktop's does. The server's
 * timers are manual: the auth timer, the heartbeat and each max-age deadline fire only when a test
 * fires them.
 */
import { randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { LIVE_PATH, liveServerMessageSchema, type LiveServerMessage } from '@wirebench/engine';
import { liveModule } from '../../src/live/module.js';
import { syncModule } from '../../src/sync/module.js';
import { teamsModule } from '../../src/teams/module.js';
import { identityHarness, type IdentityHarness } from './identity.js';
import { manualTimers, type ManualTimers } from './timers.js';

/** How long `next`, and `openLive`'s wait for `ready`, give the server before failing the test. */
const WAIT_MS = 5_000;

export interface LiveHarness extends IdentityHarness {
  readonly port: number;
  readonly timers: ManualTimers;
}

/** Identity, teams-access, server-sync and live-updates over a fresh schema, on the harness clock, listening on 127.0.0.1:0. */
export async function liveHarness(options: { readonly env?: Record<string, string> } = {}): Promise<LiveHarness> {
  const timers = manualTimers();
  const h = await identityHarness({
    ...options,
    modules: (clock) => [
      teamsModule({ now: () => clock.now }),
      syncModule(),
      liveModule({ now: () => clock.now, setTimer: timers.setTimer }),
    ],
  });
  await h.app.listen({ host: '127.0.0.1', port: 0 });
  const address = h.app.server.address();
  if (address === null || typeof address === 'string') throw new Error('the live harness is not listening on a port');
  return { ...h, port: address.port, timers };
}

export interface LiveTestClient {
  /** Every server message so far, in arrival order, each checked against `liveServerMessageSchema`. */
  readonly messages: LiveServerMessage[];
  /** The oldest message of `type` no earlier `next` returned; rejects on close or after 5 s. */
  next<T extends LiveServerMessage['type']>(type: T): Promise<Extract<LiveServerMessage, { type: T }>>;
  send(message: unknown): void;
  close(): void;
  readonly closed: Promise<{ code: number }>;
}

interface Waiter {
  readonly type: LiveServerMessage['type'];
  readonly resolve: (message: LiveServerMessage) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

function isOfType<T extends LiveServerMessage['type']>(
  message: LiveServerMessage,
  type: T,
): message is Extract<LiveServerMessage, { type: T }> {
  return message.type === type;
}

function parseServerMessage(data: unknown): LiveServerMessage | undefined {
  if (typeof data !== 'string') return undefined;
  try {
    const result = liveServerMessageSchema.safeParse(JSON.parse(data));
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Opens `/api/v1/live`. With a token it sends `auth` and resolves once `ready` arrived or the socket
 * closed, without consuming `ready`; a test that expects a refusal awaits `closed`.
 */
export async function openLive(h: Pick<LiveHarness, 'port'>, token?: string): Promise<LiveTestClient> {
  const socket = new WebSocket(`ws://127.0.0.1:${h.port}${LIVE_PATH}`);
  const messages: LiveServerMessage[] = [];
  const returned = new Set<LiveServerMessage>();
  const waiters: Waiter[] = [];
  let ended: Error | undefined;

  const failAll = (error: Error): void => {
    ended ??= error;
    for (const waiter of waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  };
  const closed = new Promise<{ code: number }>((resolve) => {
    socket.addEventListener('close', (event) => {
      failAll(new Error(`the live socket closed ${event.code}`));
      resolve({ code: event.code });
    });
  });
  socket.addEventListener('message', (event) => {
    const data: unknown = event.data;
    const message = parseServerMessage(data);
    if (message === undefined) {
      failAll(new Error(`not a live server message: ${String(data)}`));
      return;
    }
    messages.push(message);
    const index = waiters.findIndex((waiter) => waiter.type === message.type);
    const waiter = index === -1 ? undefined : waiters.splice(index, 1)[0];
    if (waiter === undefined) return;
    clearTimeout(waiter.timer);
    returned.add(message);
    waiter.resolve(message);
  });
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true });
    socket.addEventListener('error', () => reject(new Error('the live socket did not open')), { once: true });
  });

  const client: LiveTestClient = {
    messages,
    next<T extends LiveServerMessage['type']>(type: T): Promise<Extract<LiveServerMessage, { type: T }>> {
      const found = new Promise<LiveServerMessage>((resolve, reject) => {
        const waiting = messages.find((message) => message.type === type && !returned.has(message));
        if (waiting !== undefined) {
          returned.add(waiting);
          resolve(waiting);
          return;
        }
        if (ended !== undefined) {
          reject(new Error(`no ${type} message: ${ended.message}`));
          return;
        }
        const timer = setTimeout(() => {
          const index = waiters.findIndex((waiter) => waiter.timer === timer);
          if (index !== -1) waiters.splice(index, 1);
          reject(new Error(`no ${type} message within ${WAIT_MS} ms; saw ${JSON.stringify(messages)}`));
        }, WAIT_MS);
        waiters.push({ type, resolve, reject, timer });
      });
      return found.then((message) => {
        if (isOfType(message, type)) return message;
        throw new Error(`expected ${type}, got ${message.type}`);
      });
    },
    send(message: unknown): void {
      socket.send(JSON.stringify(message));
    },
    close(): void {
      socket.close(1000);
    },
    closed,
  };

  if (token !== undefined) {
    const settled = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`neither ready nor a close within ${WAIT_MS} ms`)), WAIT_MS);
      const done = (): void => {
        clearTimeout(timer);
        resolve();
      };
      socket.addEventListener('message', () => {
        if (messages.some((message) => message.type === 'ready')) done();
      });
      void closed.then(done);
    });
    client.send({ type: 'auth', token });
    await settled;
  }
  return client;
}

/**
 * A hand-made upgrade request with the given extra headers (§11: "a raw `node:http` upgrade"), since
 * the WHATWG client can neither set `Origin` nor report a refused upgrade's status. A `101` socket is
 * dropped at once.
 */
export function rawUpgrade(
  h: Pick<LiveHarness, 'port'>,
  headers: Record<string, string>,
): Promise<{ readonly status: number; readonly body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: '127.0.0.1',
      port: h.port,
      path: LIVE_PATH,
      // Its own connection: after a refusal the plugin destroys the socket, and a kept-alive one reused
      // by the next call would only report "socket hang up".
      agent: false,
      headers: {
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-version': '13',
        'sec-websocket-key': randomBytes(16).toString('base64'),
        ...headers,
      },
    });
    request.on('upgrade', (response, upgraded) => {
      upgraded.destroy();
      resolve({ status: response.statusCode ?? 0, body: '' });
    });
    request.on('response', (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        body += chunk;
      });
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
      response.on('error', reject);
    });
    request.on('error', reject);
    request.end();
  });
}
