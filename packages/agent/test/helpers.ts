/**
 * Test helpers: a platform with a reversible secret store over a temporary `userData`, a fake Wirebench
 * Server for the pairing routes (on loopback, checking every signature over the shared message builders),
 * and a `ws` client that opens the agent's socket with chosen headers.
 */
import { createHash, createPublicKey, randomBytes, randomUUID, verify } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import {
  AGENT_HEADERS,
  agentPairRequestSchema,
  agentRedeemMessage,
  agentRequestMessage,
  type AgentPairRequest,
} from '@wirebench/engine';
import type { Capability, Host, HostPlatform } from '@wirebench/host';
import { channels } from '@wirebench/wire/ipc';

export type TestPlatform = Pick<HostPlatform, 'paths' | 'secrets' | 'app' | 'capabilities'>;

const cleanups: (() => void | Promise<void>)[] = [];

/** Runs every cleanup registered since the last call; for `afterEach`. */
export async function cleanUp(): Promise<void> {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
}

export function onCleanUp(cleanup: () => void | Promise<void>): void {
  cleanups.push(cleanup);
}

/** A platform whose secrets are sealed by a marker prefix, so a test can tell sealed from plain. */
export function fakePlatform(
  capabilities: readonly Capability[] = ['send:public', 'send:private', 'files', 'ssh', 'listen', 'kerberos'],
  userData?: string,
): TestPlatform {
  const dir = userData ?? mkdtempSync(join(tmpdir(), 'wb-agent-'));
  if (userData === undefined) onCleanUp(() => rmSync(dir, { recursive: true, force: true }));
  return {
    paths: { userData: () => dir, temp: () => tmpdir(), logs: () => dir },
    secrets: {
      available: () => true,
      encrypt: (plain) => Buffer.from(`sealed:${Buffer.from(plain, 'utf8').toString('hex')}`, 'utf8'),
      decrypt: (sealed) => {
        const text = sealed.toString('utf8');
        if (!text.startsWith('sealed:')) throw new Error('not sealed');
        return Buffer.from(text.slice('sealed:'.length), 'hex').toString('utf8');
      },
    },
    app: {
      version: () => '9.9.9-test',
      runtimeVersion: () => '0.0.0-test',
      packaged: () => false,
      quit: () => undefined,
      osTheme: () => 'light',
      onOsThemeChanged: () => () => undefined,
    },
    capabilities: new Set(capabilities),
  };
}

/**
 * A host whose table answers every one of `channels` with success, so a refusal can only be the
 * agent's allowlist.
 */
export function fakeHost(channels: readonly string[] = []): Host & { attached: number } {
  const table = new Map(
    channels.map((channel) => [channel, () => Promise.resolve({ ok: true as const, value: 'served' })]),
  );
  const host = {
    attached: 0,
    handlers: table as unknown as Host['handlers'],
    attach: () => {
      host.attached += 1;
    },
    detach: () => Promise.resolve(),
    sendFromDirectory: () => Promise.reject(new Error('this fake host sends nothing')),
    shutdown: () => Promise.resolve(),
  };
  return host;
}

/** A ULID-shaped id, as the server's pairing ids are. */
export function ulidLike(): string {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  return Array.from(randomBytes(26), (byte) => alphabet[byte % 32]).join('');
}

interface FakePairing {
  readonly request: AgentPairRequest;
  port: number;
}

export interface SeenRequest {
  readonly method: string;
  readonly path: string;
  readonly body: string;
  /** Whether the signature held, for a signed route. */
  readonly signed?: boolean;
}

export interface FakeServer {
  readonly url: string;
  readonly origin: string;
  readonly email: string;
  readonly code: string;
  readonly pairings: Map<string, FakePairing>;
  readonly seen: SeenRequest[];
  /** A nonce a tab of this server would hand its agent for `pairingId`. */
  nonce(pairingId: string): string;
  /** Answer the next pairing with this origin instead of the server's own. */
  answerOrigin?: string;
  /** Never answer a redeem; count the ones the agent gave up on. */
  holdRedeem?: boolean;
  /** Answer every signed redeem and `PATCH` with this instead (a transient failure, a proxy's bare `404`). */
  signedAnswer?: { readonly status: number; readonly body?: unknown } | undefined;
  abortedRedeems: number;
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    request.on('error', reject);
  });
}

function signatureHolds(publicKey: string, message: string, signature: string): boolean {
  try {
    const key = createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' });
    return verify(null, Buffer.from(message, 'utf8'), key, Buffer.from(signature, 'base64'));
  } catch {
    return false;
  }
}

/** The server's answer for a pairing it does not hold, as `packages/server/src/agent/errors.ts` gives it. */
export const PAIRING_UNKNOWN = {
  code: 'agent-pairing-unknown',
  message: 'This machine is not paired with this server any more.',
} as const;

/** The pairing routes of §18.2, as far as the agent uses them; nonces are single-use. */
export async function startFakeServer(): Promise<FakeServer> {
  const pairings = new Map<string, FakePairing>();
  const nonces = new Map<string, string>();
  const seen: SeenRequest[] = [];
  let server: Server | undefined;
  const state: FakeServer = {
    url: '',
    origin: '',
    email: 'ada@example.test',
    code: 'ABC234',
    abortedRedeems: 0,
    pairings,
    seen,
    nonce: (pairingId) => {
      const nonce = randomUUID();
      nonces.set(nonce, pairingId);
      return nonce;
    },
  };
  server = createServer((request, response) => {
    void (async () => {
      const body = await readBody(request);
      const path = new URL(request.url ?? '/', 'http://x').pathname;
      const method = request.method ?? 'GET';
      const reply = (status: number, value?: unknown): void => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(value === undefined ? undefined : JSON.stringify(value));
      };
      const one = (name: string): string => {
        const value = request.headers[name];
        return typeof value === 'string' ? value : '';
      };
      const pairingId = one(AGENT_HEADERS.pairing);
      const timestamp = one(AGENT_HEADERS.timestamp);
      const signature = one(AGENT_HEADERS.signature);

      if (method === 'POST' && path === '/api/v1/agent/pairings') {
        seen.push({ method, path, body });
        const parsed = agentPairRequestSchema.safeParse(JSON.parse(body) as unknown);
        if (!parsed.success || parsed.data.code !== state.code) {
          reply(401, { error: { code: 'agent-pairing-code-invalid' } });
          return;
        }
        const id = ulidLike();
        pairings.set(id, { request: parsed.data, port: parsed.data.port });
        reply(201, { pairingId: id, origin: state.answerOrigin ?? state.origin, email: state.email });
        return;
      }
      if (method === 'POST' && path === '/api/v1/agent/nonces/redeem' && state.holdRedeem === true) {
        seen.push({ method, path, body });
        response.on('close', () => {
          if (!response.writableEnded) state.abortedRedeems += 1;
        });
        return;
      }
      const isSigned =
        (method === 'POST' && path === '/api/v1/agent/nonces/redeem') ||
        (method === 'PATCH' && path.startsWith('/api/v1/agent/pairings/'));
      if (isSigned && state.signedAnswer !== undefined) {
        seen.push({ method, path, body });
        reply(state.signedAnswer.status, state.signedAnswer.body);
        return;
      }
      if (method === 'POST' && path === '/api/v1/agent/nonces/redeem') {
        const { nonce } = JSON.parse(body) as { nonce: string };
        const pairing = pairings.get(pairingId);
        if (pairing === undefined) {
          seen.push({ method, path, body, signed: false });
          reply(404, PAIRING_UNKNOWN);
          return;
        }
        const signed = signatureHolds(
          pairing.request.publicKey,
          agentRedeemMessage(nonce, pairingId, timestamp),
          signature,
        );
        seen.push({ method, path, body, signed });
        if (!signed || nonces.get(nonce) !== pairingId) {
          reply(401, { error: { code: 'agent-nonce-invalid' } });
          return;
        }
        nonces.delete(nonce);
        reply(200, { userId: ulidLike(), email: state.email, displayName: 'Ada' });
        return;
      }
      const match = /^\/api\/v1\/agent\/pairings\/([^/]+)$/.exec(path);
      if (match !== null && (method === 'DELETE' || method === 'PATCH')) {
        const id = decodeURIComponent(match[1] ?? '');
        const pairing = pairings.get(id);
        const hash = createHash('sha256').update(body).digest('hex');
        const signed =
          pairing !== undefined &&
          pairingId === id &&
          signatureHolds(pairing.request.publicKey, agentRequestMessage(method, path, id, timestamp, hash), signature);
        seen.push({ method, path, body, signed });
        if (pairing === undefined) {
          reply(404, PAIRING_UNKNOWN);
          return;
        }
        if (!signed) {
          reply(401, { error: { code: 'agent-signature-invalid' } });
          return;
        }
        if (method === 'DELETE') {
          pairings.delete(id);
          reply(204);
        } else {
          pairing.port = (JSON.parse(body) as { port: number }).port;
          reply(204);
        }
        return;
      }
      reply(404);
    })();
  });
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${String(port)}`;
  Object.assign(state, { url, origin: url });
  onCleanUp(
    () =>
      new Promise<void>((resolve) => {
        server?.closeAllConnections();
        server?.close(() => {
          resolve();
        });
        server = undefined;
      }),
  );
  return state;
}

export interface OpenedSocket {
  readonly ws: WebSocket;
  /** Frames the agent sent, parsed. */
  readonly frames: unknown[];
  /** The close code once closed, or the HTTP status of a refused upgrade. */
  readonly closed: Promise<{ readonly code?: number; readonly status?: number }>;
  /** The next frame (or one already received and not yet taken). */
  next(): Promise<unknown>;
  send(value: unknown): void;
}

/** Opens `ws://127.0.0.1:<port>/host` with the given headers (an `origin` of `undefined` sends none). */
export function openSocket(
  port: number,
  options: { readonly origin?: string; readonly host?: string; readonly path?: string } = {},
): OpenedSocket {
  const headers: Record<string, string> = {};
  if (options.host !== undefined) headers.host = options.host;
  const ws = new WebSocket(`ws://127.0.0.1:${String(port)}${options.path ?? '/host'}`, {
    headers,
    ...(options.origin === undefined ? {} : { origin: options.origin }),
  });
  onCleanUp(() => {
    ws.terminate();
  });
  const frames: unknown[] = [];
  let taken = 0;
  const waiters: (() => void)[] = [];
  ws.on('message', (data: Buffer) => {
    frames.push(JSON.parse(data.toString('utf8')) as unknown);
    for (const waiter of waiters.splice(0)) waiter();
  });
  const closed = new Promise<{ code?: number; status?: number }>((resolve) => {
    ws.on('close', (code) => {
      resolve({ code });
    });
    ws.on('unexpected-response', (_request, response) => {
      resolve({ status: response.statusCode ?? 0 });
      response.resume();
    });
    ws.on('error', () => undefined);
  });
  const next = async (): Promise<unknown> => {
    while (frames.length <= taken) {
      await new Promise<void>((resolve) => waiters.push(resolve));
    }
    const frame = frames[taken];
    taken += 1;
    return frame;
  };
  const opened = new Promise<void>((resolve) => ws.once('open', () => resolve()));
  return {
    ws,
    frames,
    closed,
    next,
    send: (value) => {
      void opened.then(() => {
        ws.send(JSON.stringify(value));
      });
    },
  };
}

/** Every channel name in the registry, walked from its root. */
export function registryChannelNames(): string[] {
  const names: string[] = [];
  const walk = (node: unknown): void => {
    if (typeof node !== 'object' || node === null) return;
    const record = node as Record<string, unknown>;
    if (typeof record.name === 'string' && 'request' in record && 'response' in record) {
      names.push(record.name);
      return;
    }
    for (const value of Object.values(record)) walk(value);
  };
  walk(channels);
  return names.sort();
}

/**
 * Sends a raw upgrade request for `/host` with exactly `headers` (none added, `Host` included) and resolves
 * with the status code of the answer.
 */
export async function rawUpgradeStatus(port: number, headers: Readonly<Record<string, string>>): Promise<number> {
  return (await rawUpgrade(port, headers)).status;
}

/** As {@link rawUpgradeStatus}, with the answer's head (status line and headers) as sent. */
export function rawUpgrade(
  port: number,
  headers: Readonly<Record<string, string>>,
): Promise<{ readonly status: number; readonly head: string }> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1');
    onCleanUp(() => {
      socket.destroy();
    });
    let text = '';
    socket.on('data', (chunk: Buffer) => {
      text += chunk.toString('latin1');
      const end = text.indexOf('\r\n\r\n');
      const match = /^HTTP\/1\.1 (\d{3})/.exec(text);
      if (match !== null && end !== -1) {
        resolve({ status: Number(match[1]), head: text.slice(0, end) });
        socket.destroy();
      }
    });
    socket.on('error', reject);
    const lines = [
      'GET /host HTTP/1.1',
      ...Object.entries({
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': Buffer.from(randomUUID().slice(0, 16)).toString('base64'),
        ...headers,
      }).map(([name, value]) => `${name}: ${value}`),
      '',
      '',
    ];
    socket.write(lines.join('\r\n'));
  });
}
