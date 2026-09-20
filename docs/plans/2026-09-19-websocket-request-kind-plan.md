# WebSocket Request Kind Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship issue #98 — a fourth container, `kind: websocket`, whose requests connect to `ws://` and
`wss://`, show every frame on a live timeline, send composed and saved messages while open, close with a
code and reason, and reach the HTTP Log and History.

**Architecture:** One container-agnostic transport, `openWsSession` in `packages/engine/src/ws/session.ts`,
wraps undici's `WebSocket` over the dispatcher `createDispatcher` already builds, and reports the handshake
and every frame through hooks. Around it the gRPC pattern repeats layer for layer: a `WsApi` model beside
`GrpcApi`, a `wsApis` list on `Project`, one `kind` branch in the schema, loader and serialiser, an invoke
that stays open for the life of the session with a `ws.live` event beside it, and a renderer state whose
`live` half is dropped when the exchange arrives.

**Tech Stack:** TypeScript 5.9 (`NodeNext`, `strict`, `exactOptionalPropertyTypes`), Node ≥ 24, `undici@^8`
`WebSocket` + `node:diagnostics_channel`, Zod 4, vitest, Electron, React. No new dependency.

**Spec:** `docs/specs/2026-09-19-websocket-request-kind-design.md` — read it first; this plan argues from it.

## Global Constraints

- Branch `feat/websocket-request-kind`, cut from `main`. One commit per task, only after
  `WIREBENCH_SKIP_PERF=1 pnpm check` is green. `pnpm test:perf` unskipped before any push.
- Commit as Mohammed Naami. **No** `Co-Authored-By:` trailer, **no** `Claude-Session:` trailer, no
  generated-by footer anywhere. The message body says why.
- Never name, in code, docs or UI copy, a product that inspired a feature (`pnpm check:banned-terms`).
- No local Electron windows, no e2e run locally; CI runs e2e. Run heavy checks under `nice`.
- No new dependency, runtime or dev. If the test server in Task 1 cannot be kept near 200 lines, stop and ask.
- `packages/engine/src` imports nothing from Electron or from `apps/desktop`.
- `formatVersion` stays **3**. Do not touch `project/migrate.ts`.
- Do not change the behaviour of `sendHttp`, `createDispatcher`, the gRPC live plumbing, or `MessagesView`
  as gRPC sees it. Add siblings; if a shared change seems needed, stop and ask.
- Raw WebSocket only. Not built: Socket.IO/STOMP/MQTT framing, AsyncAPI import, GraphQL subscriptions, SSE,
  a CLI step, auto-reconnect, manual ping, scripted replies, resend/diff from History.
- Style is the engine's: `interface` with `readonly` fields, discriminated unions, no `any`, JSDoc that says
  why, errors are `WirebenchError` subclasses with a stable `code`, conditional spreads
  (`...(x !== undefined ? { x } : {})`) because `exactOptionalPropertyTypes` is on. A thing the server did is
  a result, not a throw.
- Every `kind` branch is a `switch` (or an exhaustive union) so the compiler lists what the fourth member needs.
- ADR-0005: every new file name goes through `assertPathSegment` before it is written or read.

## File Structure

```
packages/engine/
  test/helpers/test-ws-server.ts            minimal RFC 6455 server: echo, refuse, ping, close, drop, hang
  test/integration/ws/undici-spike.test.ts  Task 1 — what undici does and does not surface
  test/integration/ws/session.test.ts       the transport against the test server
  test/unit/ws/{model,url,pretty,expand,transcript,command}.test.ts
  test/unit/project/ws-format.test.ts       round trip, byte stability, rename, path safety, old-build refusal
  src/errors.ts                             + WsError
  src/ws/model.ts      WsApi, WsFolder, WsRequestDef, WsSavedMessage, WsFrame, WsHandshake, WsExchange, factories
  src/ws/url.ts        resolveWsUrl — server URL + path + query → ws(s) URL
  src/ws/pretty.ts     prettyFrameText — JSON/XML detection for a text frame
  src/ws/session.ts    openWsSession — the only file that imports undici's WebSocket
  src/ws/expand.ts     expandWsInput — ${…} over url, headers, query, subprotocols; expandWsMessage
  src/ws/call.ts       toWsSessionOptions — request + API + auth → session options
  src/ws/transcript.ts capFrames — the History cap (first 400 + last 100, 1 MB)
  src/ws/command.ts    wsToCommand — Copy as Command
  src/ws/browser.ts    subpath @wirebench/engine/ws (model, url, pretty only — no node: imports)
  src/project/{model,schema,load,serialize,save,history}.ts   the websocket branch
  src/index.ts, package.json (exports map)   the new subpath and exports
  src/run/select.ts                          skip websocket requests with a named reason
apps/desktop/src/
  main/project-ws-mutations.ts   locateWsRequest, withWsPatch, wsAuthChainFor, the *-ws-* changes
  main/ws-send.ts                resolveWsSend — draft, URL under the environment, auth chain, expansion
  main/engine-service.ts         wsSessions registry; openWsSession, sendWsMessage, closeWs, closeAllWs
  main/engine-wire.ts            toWsFrameWire, toWsExchangeSummary
  main/ipc/request.ts            request.openWs / wsSend / wsClose; curl and cancel dispatch
  main/history-service.ts        recordWsSession
  main/{project-host,project-router,project-mutations,project-wire,workspace-service,unsaved-store,search,har,log-curl,failed-exchange}.ts
  shared/{wire-types,ipc,commands,command-catalog}.ts
  renderer/state/{exchanges,project,drafts,unsaved-drafts,editors,workspace-tabs,ui-state}.ts
  renderer/features/ws-editor/   editor, connect-bar, messages-tab, subprotocols-tab, settings-tab,
                                 response-pane, timeline, frame-detail, composer, badge
  renderer/features/ws-api/      the API tab
  renderer/features/{explorer,history,search,console,environments}/   the websocket branch
  renderer/shell/{editor-area,code-panel,app-shell}.tsx, renderer/commands/register-*.ts
apps/desktop/test/  ws-mutations, ws-send-path, engine-ws-session, ipc-ws, history ws, renderer/ws-live-store,
                    renderer/ws-timeline, renderer/ws-composer, renderer/ws-editor, renderer/ws-api-tab
e2e/specs/websocket.spec.ts
docs/  adr/0007 update, success-criteria SC-W1–6, roadmap, CHANGELOG, docs-site page, command docs
```

**Reading rule for every task that adds a `kind` branch.** The gRPC branch in the same file is the
reference. Find it with `grep -n -i grpc <file>`, read the whole function it sits in, and add the websocket
member beside it. Where gRPC used an `if (… === 'grpc')`, leave it and add the new branch in the same style;
do not refactor the neighbours.

---

## Slice S1 — the transport

### Task 1: Test server and the undici spike

Answers spec §13.1 before anything is built on the answer.

**Files:**
- Create: `packages/engine/test/helpers/test-ws-server.ts`
- Create: `packages/engine/test/integration/ws/undici-spike.test.ts`
- Modify: `packages/engine/test/helpers/index.ts` (export the helper)
- Modify: `docs/specs/2026-09-19-websocket-request-kind-design.md` §13.1 (record the finding)

**Interfaces:**
- Produces:
  ```ts
  export interface TestWsHandshake { readonly url: string; readonly headers: IncomingHttpHeaders }
  export interface TestWsServerOptions {
    readonly tls?: { readonly cert: string; readonly key: string; readonly ca?: string; readonly requestCert?: boolean };
    /** Subprotocols the server accepts; it picks the first offered one that is listed. */
    readonly subprotocols?: readonly string[];
  }
  export interface TestWsServer {
    readonly url: string;                       // ws://127.0.0.1:<port> or wss://localhost:<port>
    readonly port: number;
    readonly handshakes: readonly TestWsHandshake[];
    /** Every frame the server received, unmasked, in arrival order. */
    readonly received: readonly { readonly opcode: number; readonly payload: Buffer }[];
    readonly close: () => Promise<void>;
  }
  export function startTestWsServer(options?: TestWsServerOptions): Promise<TestWsServer>;
  ```
  Paths: `/echo` echoes every text and binary frame; `/refuse` answers `401` with
  `www-authenticate: Basic realm="ws"` and body `no`; `/ping` sends a ping with payload `hi` right after the
  upgrade, then behaves as echo; `/close` answers the first message by closing with `4000` `bye`; `/drop`
  destroys the socket on the first message; `/hang` never answers the upgrade.

- [ ] **Step 1: Write the server**

```ts
/**
 * A WebSocket server small enough to read in one sitting: the upgrade handshake and the five frame
 * kinds a session test needs. No extensions, no fragmentation — undici does not fragment what it
 * sends, and a server that offers no `permessage-deflate` is a legal one.
 */
import { createHash } from 'node:crypto';
import { createServer as createHttpServer, type IncomingHttpHeaders, type IncomingMessage } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const OP = { text: 0x1, binary: 0x2, close: 0x8, ping: 0x9, pong: 0xa } as const;

export interface TestWsHandshake {
  readonly url: string;
  readonly headers: IncomingHttpHeaders;
}
export interface TestWsServerOptions {
  readonly tls?: { readonly cert: string; readonly key: string; readonly ca?: string; readonly requestCert?: boolean };
  readonly subprotocols?: readonly string[];
}
export interface TestWsServer {
  readonly url: string;
  readonly port: number;
  readonly handshakes: readonly TestWsHandshake[];
  readonly received: readonly { readonly opcode: number; readonly payload: Buffer }[];
  readonly close: () => Promise<void>;
}

/** One unmasked, unfragmented frame, as a server sends it. */
export function encodeFrame(opcode: number, payload: Buffer): Buffer {
  const length = payload.length;
  let header: Buffer;
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, length]);
  } else if (length < 65_536) {
    header = Buffer.from([0x80 | opcode, 126, length >> 8, length & 0xff]);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, payload]);
}

/** Takes every complete frame off the front of `state.buffer`, unmasking as it goes. */
function* decodeFrames(state: { buffer: Buffer }): Generator<{ opcode: number; payload: Buffer }> {
  for (;;) {
    const b = state.buffer;
    if (b.length < 2) return;
    const opcode = (b[0] ?? 0) & 0x0f;
    const masked = ((b[1] ?? 0) & 0x80) !== 0;
    let length = (b[1] ?? 0) & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (b.length < 4) return;
      length = b.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (b.length < 10) return;
      length = Number(b.readBigUInt64BE(2));
      offset = 10;
    }
    const maskOffset = offset;
    if (masked) offset += 4;
    if (b.length < offset + length) return;
    const payload = Buffer.from(b.subarray(offset, offset + length));
    if (masked) {
      for (let i = 0; i < payload.length; i += 1) {
        payload[i] = (payload[i] ?? 0) ^ (b[maskOffset + (i & 3)] ?? 0);
      }
    }
    state.buffer = b.subarray(offset + length);
    yield { opcode, payload };
  }
}

function closePayload(code: number, reason: string): Buffer {
  const body = Buffer.alloc(2 + Buffer.byteLength(reason));
  body.writeUInt16BE(code, 0);
  body.write(reason, 2);
  return body;
}

export async function startTestWsServer(options: TestWsServerOptions = {}): Promise<TestWsServer> {
  const handshakes: TestWsHandshake[] = [];
  const received: { opcode: number; payload: Buffer }[] = [];
  const sockets = new Set<Duplex>();
  const server =
    options.tls === undefined
      ? createHttpServer()
      : createHttpsServer({
          cert: options.tls.cert,
          key: options.tls.key,
          ...(options.tls.ca !== undefined ? { ca: options.tls.ca } : {}),
          ...(options.tls.requestCert === true ? { requestCert: true, rejectUnauthorized: true } : {}),
        });

  server.on('upgrade', (req: IncomingMessage, socket: Duplex) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => sockets.delete(socket));
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    handshakes.push({ url: req.url ?? '/', headers: req.headers });
    if (path === '/hang') return;
    if (path === '/refuse') {
      socket.end(
        'HTTP/1.1 401 Unauthorized\r\nwww-authenticate: Basic realm="ws"\r\ncontent-length: 2\r\nconnection: close\r\n\r\nno',
      );
      return;
    }
    const key = req.headers['sec-websocket-key'] ?? '';
    const accept = createHash('sha1').update(`${key}${GUID}`).digest('base64');
    const offered = String(req.headers['sec-websocket-protocol'] ?? '')
      .split(',')
      .map((p) => p.trim())
      .filter((p) => p !== '');
    const chosen = offered.find((p) => options.subprotocols?.includes(p) === true);
    socket.write(
      [
        'HTTP/1.1 101 Switching Protocols',
        'upgrade: websocket',
        'connection: Upgrade',
        `sec-websocket-accept: ${accept}`,
        ...(chosen !== undefined ? [`sec-websocket-protocol: ${chosen}`] : []),
        '',
        '',
      ].join('\r\n'),
    );
    if (path === '/ping') socket.write(encodeFrame(OP.ping, Buffer.from('hi')));

    const state = { buffer: Buffer.alloc(0) };
    socket.on('data', (chunk: Buffer) => {
      state.buffer = Buffer.concat([state.buffer, chunk]);
      for (const frame of decodeFrames(state)) {
        received.push(frame);
        if (frame.opcode === OP.close) {
          socket.end(encodeFrame(OP.close, frame.payload));
        } else if (frame.opcode === OP.ping) {
          socket.write(encodeFrame(OP.pong, frame.payload));
        } else if (frame.opcode === OP.text || frame.opcode === OP.binary) {
          if (path === '/close') socket.write(encodeFrame(OP.close, closePayload(4000, 'bye')));
          else if (path === '/drop') socket.destroy();
          else socket.write(encodeFrame(frame.opcode, frame.payload));
        }
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: options.tls === undefined ? `ws://127.0.0.1:${port}` : `wss://localhost:${port}`,
    port,
    handshakes,
    received,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
```

Export it from `test/helpers/index.ts`:
```ts
export {
  startTestWsServer,
  encodeFrame,
  type TestWsServer,
  type TestWsServerOptions,
  type TestWsHandshake,
} from './test-ws-server.js';
```

- [ ] **Step 2: Write the spike**

Each test pins one fact `session.ts` will rely on. A test that fails here is a *finding*, not a bug: record it.

```ts
/**
 * What undici's WebSocket tells us, pinned before the session is built on it. These are facts about a
 * dependency, so a failure after an undici upgrade says exactly which assumption moved.
 */
import diagnosticsChannel from 'node:diagnostics_channel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'undici';
import { createDispatcher } from '../../../src/http/client.js';
import { generateClientCert, generateServerCert, generateTestCa } from '../../helpers/test-certs.js';
import { startTestProxy, type TestProxy } from '../../helpers/test-proxy.js';
import { startTestWsServer, type TestWsServer } from '../../helpers/test-ws-server.js';

let server: TestWsServer;
let proxy: TestProxy;

beforeAll(async () => {
  server = await startTestWsServer({ subprotocols: ['chat.v2'] });
  proxy = await startTestProxy();
});
afterAll(async () => {
  await server.close();
  await proxy.close();
});

function opened(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true });
    socket.addEventListener('error', (event) => reject(new Error(String((event as ErrorEvent).message))), {
      once: true,
    });
  });
}
function closed(socket: WebSocket): Promise<{ code: number; reason: string; wasClean: boolean }> {
  return new Promise((resolve) => {
    socket.addEventListener(
      'close',
      (event) => resolve({ code: event.code, reason: event.reason, wasClean: event.wasClean }),
      { once: true },
    );
  });
}

describe('undici WebSocket: what it surfaces', () => {
  it('sends custom headers and negotiates a subprotocol', async () => {
    const socket = new WebSocket(`${server.url}/echo?room=1`, {
      headers: { 'x-trace': 'abc' },
      protocols: ['nope', 'chat.v2'],
    });
    await opened(socket);
    const handshake = server.handshakes.at(-1);
    expect(handshake?.headers['x-trace']).toBe('abc');
    expect(handshake?.url).toBe('/echo?room=1');
    expect(socket.protocol).toBe('chat.v2');
    socket.close(1000, 'done');
    expect(await closed(socket)).toMatchObject({ code: 1000, wasClean: true });
  });

  it('publishes the 101 and its headers on undici:websocket:open, carrying the socket', async () => {
    const seen: { websocket: unknown; handshakeResponse: { status: number; headers: Record<string, string> } }[] = [];
    const listener = (message: unknown): void => void seen.push(message as (typeof seen)[number]);
    diagnosticsChannel.subscribe('undici:websocket:open', listener);
    const socket = new WebSocket(`${server.url}/echo`);
    await opened(socket);
    diagnosticsChannel.unsubscribe('undici:websocket:open', listener);
    const mine = seen.find((m) => m.websocket === socket);
    expect(mine?.handshakeResponse.status).toBe(101);
    expect(Object.keys(mine?.handshakeResponse.headers ?? {})).toContain('sec-websocket-accept');
    socket.close();
    await closed(socket);
  });

  it('publishes a server ping on undici:websocket:ping with its payload', async () => {
    const pings: { websocket: unknown; payload: Buffer }[] = [];
    const listener = (message: unknown): void => void pings.push(message as (typeof pings)[number]);
    diagnosticsChannel.subscribe('undici:websocket:ping', listener);
    const socket = new WebSocket(`${server.url}/ping`);
    await opened(socket);
    await new Promise((resolve) => setTimeout(resolve, 50));
    diagnosticsChannel.unsubscribe('undici:websocket:ping', listener);
    expect(pings.find((p) => p.websocket === socket)?.payload.toString()).toBe('hi');
    expect(server.received.some((f) => f.opcode === 0xa)).toBe(true); // undici answered with a pong
    socket.close();
    await closed(socket);
  });

  it('exposes the request head and the socket on undici:client:sendHeaders', async () => {
    const heads: string[] = [];
    const listener = (message: unknown): void => {
      const m = message as { headers?: string; request?: { path?: string } };
      if (m.request?.path === '/echo?probe=1' && typeof m.headers === 'string') heads.push(m.headers);
    };
    diagnosticsChannel.subscribe('undici:client:sendHeaders', listener);
    const socket = new WebSocket(`${server.url}/echo?probe=1`);
    await opened(socket);
    diagnosticsChannel.unsubscribe('undici:client:sendHeaders', listener);
    expect(heads[0]?.toLowerCase()).toContain('sec-websocket-key');
    socket.close();
    await closed(socket);
  });

  it('FINDING: what a refused handshake carries', async () => {
    const socket = new WebSocket(`${server.url}/refuse`);
    const error = await new Promise<ErrorEvent>((resolve) =>
      socket.addEventListener('error', (e) => resolve(e as ErrorEvent), { once: true }),
    );
    const close = await closed(socket);
    // Print, then pin whatever is true. If a status is reachable anywhere on `error`, assert it here.
    console.info('refused handshake →', { message: error.message, error: error.error, close });
    expect(close.wasClean).toBe(false);
  });

  it('tunnels through a proxy given the same dispatcher sendHttp builds', async () => {
    const dispatcher = createDispatcher({ proxy: { url: proxy.url } });
    const socket = new WebSocket(`${server.url}/echo`, { dispatcher });
    await opened(socket);
    expect(proxy.requests.some((r) => r.method === 'CONNECT' && r.target.endsWith(`:${server.port}`))).toBe(true);
    socket.close();
    await closed(socket);
    await dispatcher.close();
  });

  it('presents a client certificate and trusts a custom CA over wss', async () => {
    const ca = generateTestCa();
    const serverCert = generateServerCert(ca);
    const clientCert = generateClientCert(ca);
    const secure = await startTestWsServer({
      tls: { cert: serverCert.certPem, key: serverCert.keyPem, ca: ca.certPem, requestCert: true },
    });
    const dispatcher = createDispatcher({
      tls: { ca: [ca.certPem], cert: clientCert.certPem, key: clientCert.keyPem },
    });
    const socket = new WebSocket(`${secure.url}/echo`, { dispatcher });
    await opened(socket);
    socket.close();
    await closed(socket);
    await dispatcher.close();
    await secure.close();
  });
});
```

Before running, open `test/helpers/test-certs.ts` and use the real field names of `TestCertificate` (the
snippet assumes `certPem` / `keyPem`) and the real parameter list of `generateServerCert`.

- [ ] **Step 3: Run it**

Run: `pnpm vitest run packages/engine/test/integration/ws/undici-spike.test.ts`
Expected: every test passes except possibly the two the spec flagged. For each that fails, decide:
- *proxy or client certificate fails* → **stop and report**; decision 2 of the spec rests on it.
- *`sendHeaders` does not carry the head* → the Handshake tab shows the headers Wirebench asked for, without
  the `sec-websocket-*` ones undici adds. Note it in spec §13 and relax the assertion to document the gap.
- *refused handshake carries no status* → as decided 2026-09-19: accept, note it in spec §13.1.

- [ ] **Step 4: Record the finding in the spec** — replace the text of §13.1 with what the run printed for the
  refused handshake (the exact fields available) and whether the request head was observable.

- [ ] **Step 5: Gate and commit**

```bash
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add packages/engine/test/helpers packages/engine/test/integration/ws docs/specs/2026-09-19-websocket-request-kind-design.md
git commit -m "test(ws): a test server and the facts about undici the session rests on"
```

### Task 2: `ws/model.ts`, `ws/url.ts`, `ws/pretty.ts`, `WsError`

**Files:**
- Create: `packages/engine/src/ws/model.ts`, `url.ts`, `pretty.ts`, `browser.ts`
- Modify: `packages/engine/src/errors.ts` (add `WsError` under `GrpcError`, same shape)
- Modify: `packages/engine/src/index.ts`, `packages/engine/package.json` (`exports["./ws"]`, copied from `"./grpc"`)
- Test: `packages/engine/test/unit/ws/model.test.ts`, `url.test.ts`, `pretty.test.ts`

**Interfaces:**
- Consumes: `AuthConfig`, `CreateOptions`, `generateId` from `project/model.ts`; `slugify` from
  `project/paths.ts`; `KeyValueEntry` from `rest/model.ts`; `SslInfo` from `http/tls.ts`.
- Produces (exact names every later task uses):

```ts
export interface WsRequestSettings {
  readonly handshakeTimeoutMs?: number;
  readonly trustInvalid?: boolean;
  readonly sslKeystoreRef?: string;
  readonly bindAddress?: string;
  /** Close the session when a received message is larger than this. */
  readonly maxMessageBytes?: number;
  readonly escapeProperties?: boolean;
}
export interface WsSavedMessage {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly format: 'text' | 'binary';
  /** The text as edited; for `binary`, base64. Stored in `<request-slug>.msg-<slug>.<ext>`. */
  readonly content: string;
}
export interface WsRequestDef {
  readonly kind: 'websocket';
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly order: number;
  readonly description?: string;
  /** A path joined to the API's server URL, or an absolute `ws(s)://` / `http(s)://` URL. */
  readonly url: string;
  readonly query: readonly KeyValueEntry[];
  readonly headers: readonly KeyValueEntry[];
  readonly subprotocols: readonly string[];
  readonly auth: AuthConfig;
  readonly settings: WsRequestSettings;
  readonly messages: readonly WsSavedMessage[];
}
export interface WsFolder {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly order: number;
  readonly description?: string;
  readonly auth?: AuthConfig;
  readonly folders: readonly WsFolder[];
  readonly requests: readonly WsRequestDef[];
}
/** Reserved for the contract import (#100); nothing in this plan reads it. */
export interface WsDefinitionRef {
  readonly kind: 'asyncapi';
  readonly source: string;
  readonly cache: boolean;
}
export interface WsApi {
  readonly kind: 'websocket';
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly order: number;
  readonly description?: string;
  /** The server URL; may hold `${…}`; an environment overrides it under the API's slug. */
  readonly url: string;
  readonly headers: readonly KeyValueEntry[];
  readonly auth?: AuthConfig;
  readonly definition?: WsDefinitionRef;
  readonly folders: readonly WsFolder[];
  readonly requests: readonly WsRequestDef[];
}
export type WsOpcode = 'text' | 'binary' | 'ping' | 'pong' | 'close';
export interface WsFrame {
  readonly index: number;
  readonly direction: 'sent' | 'received';
  readonly opcode: WsOpcode;
  /** Milliseconds since the session started. */
  readonly at: number;
  /** Payload bytes. */
  readonly size: number;
  readonly text?: string;
  readonly base64?: string;
  readonly close?: { readonly code: number; readonly reason: string };
  readonly payloadTruncated?: boolean;
}
export interface WsHandshake {
  readonly url: string;
  readonly requestHeaders: Readonly<Record<string, string>>;
  readonly requestedSubprotocols: readonly string[];
  readonly rawRequestHead?: string;
  readonly status?: number;
  readonly statusText?: string;
  readonly responseHeaders?: Readonly<Record<string, string>>;
  readonly protocol?: string;
  readonly extensions?: string;
  readonly remoteAddress?: string;
  readonly startedAt: string;
  readonly durationMs: number;
  readonly tls?: SslInfo;
  readonly error?: string;
}
export interface WsExchange {
  readonly kind: 'websocket';
  readonly url: string;
  readonly handshake: WsHandshake;
  readonly frames: readonly WsFrame[];
  readonly closed: { readonly code: number; readonly reason: string; readonly by: 'client' | 'server' | 'error' };
  readonly counts: {
    readonly sent: number;
    readonly received: number;
    readonly bytesSent: number;
    readonly bytesReceived: number;
  };
  readonly durationMs: number;
}
export function createWsApi(name: string, input?: CreateWsApiInput): WsApi;
export function createWsFolder(name: string, input?: CreateWsFolderInput): WsFolder;
export function createWsRequest(name: string, input?: CreateWsRequestInput): WsRequestDef;
export function createWsSavedMessage(
  name: string,
  input?: CreateOptions & { readonly slug?: string; readonly format?: 'text' | 'binary'; readonly content?: string },
): WsSavedMessage;
export function wsApiRequests(api: WsApi): WsRequestDef[];
export function wsApiFolders(api: WsApi): WsFolder[];
export function wsMessageFileName(
  requestSlug: string,
  message: Pick<WsSavedMessage, 'slug' | 'format' | 'content'>,
): string;

// url.ts — throws WsError 'ws-bad-url'
export function resolveWsUrl(serverUrl: string, requestUrl: string, query: readonly KeyValueEntry[]): string;
// pretty.ts
export function prettyFrameText(text: string): { readonly language: 'json' | 'xml' | 'text'; readonly pretty: string };
```
  `CreateWsApiInput`, `CreateWsFolderInput` and `CreateWsRequestInput` extend `CreateOptions` with every
  non-identity field of their type as optional, exactly as `CreateGrpcApiInput` does for `GrpcApi`.

- [ ] **Step 1: Write the failing tests**

`url.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { WsError } from '../../../src/errors.js';
import { resolveWsUrl } from '../../../src/ws/url.js';

const row = (name: string, value: string, enabled = true) => ({ name, value, enabled });

describe('resolveWsUrl', () => {
  it('joins a path to the server URL', () => {
    expect(resolveWsUrl('wss://api.example.test/v1', '/feed', [])).toBe('wss://api.example.test/v1/feed');
    expect(resolveWsUrl('wss://api.example.test/v1/', 'feed', [])).toBe('wss://api.example.test/v1/feed');
  });
  it('lets an absolute request URL win', () => {
    expect(resolveWsUrl('wss://a.test', 'ws://b.test/x', [])).toBe('ws://b.test/x');
  });
  it('maps http(s) to ws(s)', () => {
    expect(resolveWsUrl('https://a.test', '/x', [])).toBe('wss://a.test/x');
    expect(resolveWsUrl('http://a.test', '', [])).toBe('ws://a.test/');
  });
  it('appends enabled query rows to any query already in the URL', () => {
    expect(resolveWsUrl('ws://a.test', '/x?a=1', [row('b', 'two words'), row('c', '3', false)])).toBe(
      'ws://a.test/x?a=1&b=two+words',
    );
  });
  it('refuses another scheme, and an empty URL, by name', () => {
    expect(() => resolveWsUrl('ftp://a.test', '/x', [])).toThrowError(WsError);
    expect(() => resolveWsUrl('', '', [])).toThrowError(expect.objectContaining({ code: 'ws-bad-url' }));
  });
});
```

`pretty.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { prettyFrameText } from '../../../src/ws/pretty.js';

describe('prettyFrameText', () => {
  it('indents JSON', () =>
    expect(prettyFrameText('{"a":[1,2]}')).toEqual({ language: 'json', pretty: '{\n  "a": [\n    1,\n    2\n  ]\n}' }));
  it('leaves a bare number or word as text', () => {
    expect(prettyFrameText('42').language).toBe('text');
    expect(prettyFrameText('ping').language).toBe('text');
  });
  it('recognises XML', () => expect(prettyFrameText('<a><b>1</b></a>').language).toBe('xml'));
  it('returns broken JSON untouched', () =>
    expect(prettyFrameText('{"a":')).toEqual({ language: 'text', pretty: '{"a":' }));
});
```

`model.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import {
  createWsApi,
  createWsRequest,
  createWsSavedMessage,
  wsApiRequests,
  wsMessageFileName,
} from '../../../src/ws/model.js';

describe('ws model', () => {
  it('creates a request with inherited auth and nothing saved', () => {
    expect(createWsRequest('Feed', { id: 'r1' })).toMatchObject({
      kind: 'websocket',
      slug: 'Feed',
      url: '',
      auth: { type: 'inherit' },
      messages: [],
      subprotocols: [],
    });
  });
  it('walks folders depth-first', () => {
    const inner = createWsRequest('Inner', { id: 'r2' });
    const api = createWsApi('Live', {
      id: 'a1',
      folders: [{ id: 'f1', name: 'F', slug: 'f', order: 0, folders: [], requests: [inner] }],
    });
    expect(wsApiRequests(api).map((r) => r.id)).toEqual(['r2']);
  });
  it('names a message file by what it holds', () => {
    const name = (n: string, input: Parameters<typeof createWsSavedMessage>[1]) =>
      wsMessageFileName('Feed', createWsSavedMessage(n, input));
    expect(name('Subscribe', { content: '{"op":"sub"}' })).toBe('Feed.msg-Subscribe.json');
    expect(name('Hello', { content: '<hi/>' })).toBe('Feed.msg-Hello.xml');
    expect(name('Plain', { content: 'hi' })).toBe('Feed.msg-Plain.txt');
    expect(name('Blob', { format: 'binary', content: 'AAEC' })).toBe('Feed.msg-Blob.b64');
  });
});
```

- [ ] **Step 2: Run to see them fail** — `pnpm vitest run packages/engine/test/unit/ws` → FAIL, modules not found.

- [ ] **Step 3: Implement**

`model.ts`: the interfaces above verbatim, then the factories in the exact shape of `createGrpcApi` /
`createGrpcFolder` / `createGrpcRequest` in `grpc/model.ts` (same `idOf`, same conditional spreads), under a
file header that says: fourth sibling container, ADR-0007, own list on the project, never holds a secret.
```ts
export function wsMessageFileName(
  requestSlug: string,
  message: Pick<WsSavedMessage, 'slug' | 'format' | 'content'>,
): string {
  const language = message.format === 'binary' ? 'b64' : prettyFrameText(message.content).language;
  return `${requestSlug}.msg-${message.slug}.${language === 'text' ? 'txt' : language}`;
}
```

`url.ts`:
```ts
import { WsError } from '../errors.js';
import type { KeyValueEntry } from '../rest/model.js';

const SCHEME: Readonly<Record<string, string>> = { 'ws:': 'ws:', 'wss:': 'wss:', 'http:': 'ws:', 'https:': 'wss:' };

/** The URL a session dials: the request's own when absolute, else its path under the server URL. */
export function resolveWsUrl(serverUrl: string, requestUrl: string, query: readonly KeyValueEntry[]): string {
  const absolute = /^[a-z][a-z0-9+.-]*:\/\//i.test(requestUrl);
  const joined = absolute
    ? requestUrl
    : requestUrl === ''
      ? serverUrl
      : `${serverUrl.replace(/\/+$/, '')}/${requestUrl.replace(/^\/+/, '')}`;
  let url: URL;
  try {
    url = new URL(joined);
  } catch {
    throw new WsError('ws-bad-url', `"${joined}" is not a URL`, { details: { url: joined } });
  }
  const scheme = SCHEME[url.protocol];
  if (scheme === undefined) {
    throw new WsError('ws-bad-url', `A WebSocket URL starts with ws:// or wss://, not ${url.protocol}//`, {
      details: { url: joined },
    });
  }
  url.protocol = scheme;
  for (const row of query) {
    if (row.enabled && row.name !== '') url.searchParams.append(row.name, row.value);
  }
  return url.toString();
}
```
Check `KeyValueEntry`'s real field names in `rest/model.ts` before relying on `enabled` / `name` / `value`.
Node's `URL` refuses to change a special scheme to a non-special one but `http:` → `ws:` is special → special
and is allowed; if the `maps http(s) to ws(s)` test fails on this, rebuild the string instead:
`` `${scheme}//${url.host}${url.pathname}${url.search}` `` before appending the query rows.

`pretty.ts`: JSON when the trimmed text starts with `{` or `[` and `JSON.parse` succeeds →
`JSON.stringify(value, null, 2)`; XML when it starts with `<` and the engine's XML parser accepts it — use the
existing formatter in `src/xml/` (find it with `grep -rn "^export function" packages/engine/src/xml | grep -i "pretty\|format"`);
otherwise `{ language: 'text', pretty: text }`. `pretty.ts` must stay browser-safe: if the XML formatter pulls
a `node:` import, detect XML with the parser only and return the text unformatted with `language: 'xml'`.

`browser.ts`: re-export `model.ts`, `url.ts`, `pretty.ts` — mirror `grpc/browser.ts`.

- [ ] **Step 4: Run** — `pnpm vitest run packages/engine/test/unit/ws` → PASS.
- [ ] **Step 5: Gate and commit** — `feat(ws): the model, URL resolution and frame pretty-printing`.

### Task 3: `openWsSession`

**Files:**
- Create: `packages/engine/src/ws/session.ts`
- Test: `packages/engine/test/integration/ws/session.test.ts`
- Modify: `packages/engine/src/index.ts`

**Interfaces:**
- Consumes: `createDispatcher` (`http/client.ts`), `TlsOptions`, `ProxyOptions` (`http/types.ts`),
  `sslInfoForSocket` (`http/tls.ts`), `WsFrame` / `WsHandshake` / `WsExchange` (Task 2), `WsError`.
- Produces:
```ts
export interface WsSessionOptions {
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly subprotocols?: readonly string[];
  readonly tls?: TlsOptions;
  readonly proxy?: ProxyOptions;
  readonly localAddress?: string;
  /** Default 30 000. */
  readonly handshakeTimeoutMs?: number;
  /** Default unlimited. A larger received message ends the session from this side. */
  readonly maxMessageBytes?: number;
  readonly signal?: AbortSignal;
}
export interface WsSessionHooks {
  onHandshake?(handshake: WsHandshake): void;
  onFrame?(frame: WsFrame): void;
  onClosed?(exchange: WsExchange): void;
}
export interface WsSessionHandle {
  /** @throws WsError `ws-session-closed` */
  send(data: string | Uint8Array): WsFrame;
  /** Idempotent. @throws WsError `ws-bad-close` for a code an application may not send. */
  close(code?: number, reason?: string): void;
  readonly isOpen: boolean;
  /** Never rejects. */
  readonly done: Promise<WsExchange>;
}
export function openWsSession(options: WsSessionOptions, hooks?: WsSessionHooks): WsSessionHandle;
```

- [ ] **Step 1: Write the failing tests** (`session.test.ts`). Copy the `until` helper from
  `test/integration/grpc/streaming.test.ts`. The first test in full:

```ts
it('echoes text and binary, recording both directions in order', async () => {
  const frames: WsFrame[] = [];
  const session = openWsSession({ url: `${server.url}/echo` }, { onFrame: (f) => frames.push(f) });
  await until(() => session.isOpen, 'open');
  session.send('hello');
  await until(() => frames.length === 2, 'the text echo');
  session.send(new Uint8Array([0, 1, 2]));
  await until(() => frames.length === 4, 'the binary echo');
  session.close(1000, 'done');
  const exchange = await session.done;
  expect(exchange.frames.map((f) => [f.direction, f.opcode])).toEqual([
    ['sent', 'text'],
    ['received', 'text'],
    ['sent', 'binary'],
    ['received', 'binary'],
    ['sent', 'close'],
    ['received', 'close'],
  ]);
  expect(exchange.frames[3]).toMatchObject({ base64: 'AAEC', size: 3 });
  expect(exchange.closed).toEqual({ code: 1000, reason: 'done', by: 'client' });
  expect(exchange.counts).toEqual({ sent: 2, received: 2, bytesSent: 8, bytesReceived: 8 });
  expect(exchange.handshake.status).toBe(101);
});
```
  Then one `it` for each of these, in the same style, asserting on the resolved `WsExchange` and hook order:
  1. headers and query reach the server (`server.handshakes.at(-1)`);
  2. an accepted subprotocol is `handshake.protocol`; an unlisted one leaves it undefined and the session still opens;
  3. `/ping` yields a `received ping` row then a `sent pong` row, both with `base64: 'aGk='`;
  4. `/close` → `closed` equals `{ code: 4000, reason: 'bye', by: 'server' }`;
  5. `/drop` → `closed.by === 'error'` and `closed.code === 1006`;
  6. `/refuse` → `done` **resolves**, `by: 'error'`, no frames, `handshake.error` defined (and
     `handshake.status === 401` only if Task 1 found it reachable);
  7. `/hang` with `handshakeTimeoutMs: 100` → `by: 'error'`, `handshake.error` matches `/100 ms/`;
  8. aborting `signal` during `/hang` → `by: 'error'`, `handshake.error` matches `/cancel/i`;
  9. `wss` with the custom CA opens and `handshake.tls` is defined;
  10. an untrusted certificate fails, and opens with `tls: { rejectUnauthorized: false }`;
  11. a client certificate is presented (server started with `requestCert: true`);
  12. through `startTestProxy`, a `CONNECT` is recorded;
  13. `maxMessageBytes: 4` and a 5-byte echo → `closed.by === 'client'`, `closed.reason === 'message too big'`;
  14. `send` after `close` throws `WsError` with `code: 'ws-session-closed'`;
  15. `close(999)` throws `code: 'ws-bad-close'` and leaves the session open;
  16. `onClosed` fires exactly once and after the last `onFrame`.

- [ ] **Step 2: Run** — FAIL, `session.js` missing.

- [ ] **Step 3: Implement**

```ts
/**
 * One WebSocket connection from handshake to close, and the only file that touches undici's
 * WebSocket. It knows nothing about projects or containers: a saved WebSocket request opens one
 * through `call.ts`, and anything else that needs a socket — a subscription protocol layered on a
 * subprotocol, a contract check wrapped around `onFrame` — opens one the same way.
 *
 * Whatever the server does is a result. `done` never rejects: a refused handshake, a dropped
 * socket and a clean close all resolve with the exchange that records them.
 */
import diagnosticsChannel from 'node:diagnostics_channel';
import { WebSocket } from 'undici';
import { WsError } from '../errors.js';
import { createDispatcher } from '../http/client.js';
import { sslInfoForSocket, type SslInfo, type TlsSocketLike } from '../http/tls.js';
import type { WsExchange, WsFrame, WsHandshake, WsOpcode } from './model.js';

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 30_000;

/** RFC 6455 §7.4, as the WHATWG API enforces it: 1000, or the 3000–4999 range. */
function assertCloseCode(code: number): void {
  if (code !== 1000 && !(code >= 3000 && code <= 4999)) {
    throw new WsError('ws-bad-close', `${code} is not a close code an application may send (1000, or 3000–4999)`, {
      details: { code },
    });
  }
}

export function openWsSession(options: WsSessionOptions, hooks: WsSessionHooks = {}): WsSessionHandle {
  const startedMs = performance.now();
  const startedAt = new Date().toISOString();
  const timeoutMs = options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
  // `createDispatcher` hands back the shared keep-alive agent when given nothing; that one is not ours to close.
  const ownsDispatcher =
    options.tls !== undefined || options.proxy !== undefined || options.localAddress !== undefined;
  const dispatcher = createDispatcher({
    ...(options.tls !== undefined ? { tls: options.tls } : {}),
    ...(options.proxy !== undefined ? { proxy: options.proxy } : {}),
    ...(options.localAddress !== undefined ? { localAddress: options.localAddress } : {}),
  });
  const target = new URL(options.url);
  const httpOrigin = `${target.protocol === 'wss:' ? 'https:' : 'http:'}//${target.host}`;
  const frames: WsFrame[] = [];
  const counts = { sent: 0, received: 0, bytesSent: 0, bytesReceived: 0 };
  let handshake: WsHandshake | undefined;
  let rawRequestHead: string | undefined;
  let tls: SslInfo | undefined;
  let closedBy: 'client' | 'server' | 'error' | undefined;
  let failure: string | undefined;
  let settled = false;

  const record = (
    direction: WsFrame['direction'],
    opcode: WsOpcode,
    payload: string | Uint8Array,
    close?: WsFrame['close'],
  ): WsFrame => {
    const bytes = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : Buffer.from(payload);
    const binaryish = opcode === 'binary' || ((opcode === 'ping' || opcode === 'pong') && bytes.length > 0);
    const frame: WsFrame = {
      index: frames.length,
      direction,
      opcode,
      at: Math.round(performance.now() - startedMs),
      size: bytes.length,
      ...(opcode === 'text' ? { text: bytes.toString('utf8') } : {}),
      ...(binaryish ? { base64: bytes.toString('base64') } : {}),
      ...(close !== undefined ? { close } : {}),
    };
    frames.push(frame);
    if (opcode === 'text' || opcode === 'binary') {
      if (direction === 'sent') {
        counts.sent += 1;
        counts.bytesSent += bytes.length;
      } else {
        counts.received += 1;
        counts.bytesReceived += bytes.length;
      }
    }
    hooks.onFrame?.(frame);
    return frame;
  };

  const buildHandshake = (
    extra: Partial<
      Pick<
        WsHandshake,
        'status' | 'statusText' | 'responseHeaders' | 'protocol' | 'extensions' | 'remoteAddress' | 'error'
      >
    >,
  ): WsHandshake => ({
    url: options.url,
    requestHeaders: { ...(options.headers ?? {}) },
    requestedSubprotocols: [...(options.subprotocols ?? [])],
    ...(rawRequestHead !== undefined ? { rawRequestHead } : {}),
    startedAt,
    durationMs: Math.round(performance.now() - startedMs),
    ...(tls !== undefined ? { tls } : {}),
    ...(Object.fromEntries(Object.entries(extra).filter(([, v]) => v !== undefined && v !== '')) as typeof extra),
  });

  // Subscribed before the socket exists: undici starts the handshake inside the constructor.
  // The request head and the TLS session come from the channel `TimingTracker` reads, matched on
  // origin and path rather than identity because the request object is undici's own.
  const onSendHeaders = (message: unknown): void => {
    const m = message as {
      headers?: unknown;
      socket?: TlsSocketLike & { encrypted?: boolean };
      request?: { origin?: unknown; path?: string };
    };
    const origin =
      typeof m.request?.origin === 'string'
        ? m.request.origin
        : m.request?.origin instanceof URL
          ? m.request.origin.origin
          : undefined;
    if (rawRequestHead !== undefined || origin !== httpOrigin) return;
    if (m.request?.path !== `${target.pathname}${target.search}`) return;
    if (typeof m.headers === 'string') rawRequestHead = m.headers;
    if (m.socket?.encrypted === true) tls = sslInfoForSocket(m.socket);
  };
  let socket: WebSocket | undefined;
  const onOpenChannel = (message: unknown): void => {
    const m = message as {
      websocket?: unknown;
      address?: { address?: string; port?: number };
      protocol?: string;
      extensions?: string;
      handshakeResponse?: { status: number; statusText: string; headers: Record<string, string> };
    };
    if (m.websocket !== socket) return;
    handshake = buildHandshake({
      status: m.handshakeResponse?.status,
      statusText: m.handshakeResponse?.statusText,
      responseHeaders: m.handshakeResponse?.headers,
      protocol: m.protocol,
      extensions: m.extensions,
      remoteAddress: m.address?.address !== undefined ? `${m.address.address}:${m.address.port ?? ''}` : undefined,
    });
    hooks.onHandshake?.(handshake);
  };
  const onPing = (message: unknown): void => {
    const m = message as { websocket?: unknown; payload?: Uint8Array };
    if (m.websocket !== socket) return;
    const payload = m.payload ?? new Uint8Array();
    record('received', 'ping', payload);
    record('sent', 'pong', payload); // undici answers a ping itself, with the same payload
  };
  const onPong = (message: unknown): void => {
    const m = message as { websocket?: unknown; payload?: Uint8Array };
    if (m.websocket === socket) record('received', 'pong', m.payload ?? new Uint8Array());
  };
  diagnosticsChannel.subscribe('undici:client:sendHeaders', onSendHeaders);
  diagnosticsChannel.subscribe('undici:websocket:open', onOpenChannel);
  diagnosticsChannel.subscribe('undici:websocket:ping', onPing);
  diagnosticsChannel.subscribe('undici:websocket:pong', onPong);

  socket = new WebSocket(options.url, {
    dispatcher,
    ...(options.headers !== undefined ? { headers: { ...options.headers } } : {}),
    ...(options.subprotocols !== undefined && options.subprotocols.length > 0
      ? { protocols: [...options.subprotocols] }
      : {}),
  });
  socket.binaryType = 'arraybuffer';
  const ws = socket;

  /** Ends a session the server never ended: a timeout, or an abort. */
  const fail = (message: string): void => {
    failure ??= message;
    closedBy ??= 'error';
    // There is no abort for a connecting socket; close() on one fails the handshake, which is the point.
    ws.close();
  };
  const timer = setTimeout(() => {
    if (handshake === undefined) fail(`The server did not answer the handshake within ${timeoutMs} ms`);
  }, timeoutMs);
  const onAbort = (): void => fail('The connection was cancelled');
  if (options.signal?.aborted === true) queueMicrotask(onAbort);
  options.signal?.addEventListener('abort', onAbort, { once: true });

  let resolveDone!: (exchange: WsExchange) => void;
  const done = new Promise<WsExchange>((resolve) => {
    resolveDone = resolve;
  });

  ws.addEventListener('message', (event) => {
    const data = event.data as string | ArrayBuffer;
    const frame =
      typeof data === 'string' ? record('received', 'text', data) : record('received', 'binary', new Uint8Array(data));
    if (options.maxMessageBytes !== undefined && frame.size > options.maxMessageBytes && closedBy === undefined) {
      // 1009 is the code for this, and an application may not send it; 1000 with the reason is what it can say.
      closedBy = 'client';
      record('sent', 'close', 'message too big', { code: 1000, reason: 'message too big' });
      ws.close(1000, 'message too big');
    }
  });
  ws.addEventListener('error', (event) => {
    failure ??= String((event as ErrorEvent).message ?? '') || 'The connection failed';
  });
  ws.addEventListener('close', (event) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
    diagnosticsChannel.unsubscribe('undici:client:sendHeaders', onSendHeaders);
    diagnosticsChannel.unsubscribe('undici:websocket:open', onOpenChannel);
    diagnosticsChannel.unsubscribe('undici:websocket:ping', onPing);
    diagnosticsChannel.unsubscribe('undici:websocket:pong', onPong);
    const clean = event.wasClean && handshake !== undefined;
    const by = closedBy ?? (clean ? 'server' : 'error');
    if (clean) record('received', 'close', event.reason, { code: event.code, reason: event.reason });
    let settledHandshake = handshake ?? buildHandshake({ error: failure ?? 'The handshake failed' });
    if (by === 'error' && settledHandshake.error === undefined && failure !== undefined) {
      settledHandshake = { ...settledHandshake, error: failure };
    }
    const exchange: WsExchange = {
      kind: 'websocket',
      url: options.url,
      handshake: settledHandshake,
      frames,
      closed: { code: event.code, reason: event.reason, by },
      counts: { ...counts },
      durationMs: Math.round(performance.now() - startedMs),
    };
    if (ownsDispatcher) void dispatcher.close();
    hooks.onClosed?.(exchange);
    resolveDone(exchange);
  });

  return {
    get isOpen() {
      return ws.readyState === WebSocket.OPEN;
    },
    done,
    send(data) {
      if (ws.readyState !== WebSocket.OPEN) throw new WsError('ws-session-closed', 'The connection is closed');
      ws.send(data);
      return record('sent', typeof data === 'string' ? 'text' : 'binary', data);
    },
    close(code = 1000, reason = '') {
      if (ws.readyState === WebSocket.CLOSING || ws.readyState === WebSocket.CLOSED) return;
      assertCloseCode(code);
      closedBy ??= 'client';
      if (ws.readyState === WebSocket.OPEN) record('sent', 'close', reason, { code, reason });
      ws.close(code, reason);
    },
  };
}
```

**Two amendments from Task 1's findings (undici 8.10.2) — they override the listing above:**

- **The proxy agent.** `createDispatcher({ proxy })` does not CONNECT-tunnel a WebSocket handshake: undici
  rewrites `ws:` to `http:` and `ProxyAgent` only tunnels `http:` when `proxyTunnel` is true. So build the
  dispatcher like this, leaving `createDispatcher` untouched, and always own (and close) a proxy agent:
  ```ts
  import { ProxyAgent } from 'undici';
  import { createDispatcher, proxyAgentOptionsFor } from '../http/client.js';

  const dispatcher =
    options.proxy !== undefined
      ? new ProxyAgent(
          proxyAgentOptionsFor(
            options.proxy,
            {
              ...(options.tls !== undefined ? { tls: options.tls } : {}),
              ...(options.localAddress !== undefined ? { localAddress: options.localAddress } : {}),
            },
            false,
            { proxyTunnel: true },
          ),
        )
      : createDispatcher({
          ...(options.tls !== undefined ? { tls: options.tls } : {}),
          ...(options.localAddress !== undefined ? { localAddress: options.localAddress } : {}),
        });
  ```
- **A refused handshake may never fire `close`.** On an origin whose connection is pooled, only `error`
  fires. Move the body of the `close` listener into a `settle(code, reason, wasClean)` function guarded by
  `settled`; call it from `close`, and from `error` **when no handshake has happened** as
  `settle(1006, '', false)` on the next macrotask (`setTimeout(…, 0)`), so a `close` that does arrive wins and
  carries its own code. An empty `error.message` becomes `The server refused the WebSocket handshake`. Add a
  test: open and close `/echo` first, then `/refuse` on the same server — `done` must still resolve.
  No HTTP status is available for a refusal; `handshake.status` stays undefined (test 6 asserts that).

Settle these against the tests, not by guessing:
1. **`closed.code` in test 13** is whatever the close event reports after a client `close(1000, …)` — expect
   `1000`. Test 13 asserts on `by` and `reason` for that reason.
2. **A failed handshake with a server-side close row.** `clean` requires a handshake, so a refused upgrade
   records no close row — test 6 pins "no frames".
3. If `diagnosticsChannel.subscribe` ordering makes `onOpenChannel` run before `socket` is assigned (it
   cannot with a network round trip in between, but a test double could), the `let socket` declaration above
   the handlers is what keeps the comparison safe.

- [ ] **Step 4: Run** — `pnpm vitest run packages/engine/test/integration/ws/session.test.ts` → PASS.
  Run it three times in a row; a flaky ordering test here becomes a flaky desktop test later.
- [ ] **Step 5: Export** `openWsSession` and its three types from `src/index.ts` beside the gRPC exports.
- [ ] **Step 6: Gate and commit** — `feat(ws): a session over undici's WebSocket that reports itself as it runs`.

### Task 4: `ws/transcript.ts` — the History cap

**Files:** Create `packages/engine/src/ws/transcript.ts`; Test `packages/engine/test/unit/ws/transcript.test.ts`.

**Interfaces — Produces:**
```ts
export const WS_HISTORY_HEAD = 400;
export const WS_HISTORY_TAIL = 100;
export const WS_HISTORY_MAX_BYTES = 1_048_576;
export interface WsTranscript {
  readonly frames: readonly WsFrame[];
  readonly truncated: boolean;
  readonly omittedFrames: number;
}
export function capFrames(frames: readonly WsFrame[]): WsTranscript;
```

- [ ] **Step 1: Failing tests**
```ts
import { describe, expect, it } from 'vitest';
import type { WsFrame } from '../../../src/ws/model.js';
import { capFrames } from '../../../src/ws/transcript.js';

const text = (index: number, size = 10): WsFrame => ({
  index,
  direction: 'received',
  opcode: 'text',
  at: index,
  size,
  text: 'x'.repeat(size),
});
const closeRow = (index: number): WsFrame => ({
  index,
  direction: 'received',
  opcode: 'close',
  at: index,
  size: 0,
  close: { code: 1000, reason: '' },
});

describe('capFrames', () => {
  it('keeps a short session whole', () => {
    const frames = [text(0), text(1)];
    expect(capFrames(frames)).toEqual({ frames, truncated: false, omittedFrames: 0 });
  });
  it('keeps the first 400 and the last 100, and says how many went', () => {
    const result = capFrames(Array.from({ length: 1000 }, (_, i) => text(i)));
    expect(result.frames).toHaveLength(500);
    expect(result.frames[399]?.index).toBe(399);
    expect(result.frames[400]?.index).toBe(900);
    expect(result).toMatchObject({ truncated: true, omittedFrames: 500 });
  });
  it('keeps the close frame, which is among the last 100', () => {
    const result = capFrames([...Array.from({ length: 1000 }, (_, i) => text(i)), closeRow(1000)]);
    expect(result.frames.at(-1)?.opcode).toBe('close');
    expect(result.frames).toHaveLength(500);
  });
  it('past 1 MB a frame keeps its row and loses its payload', () => {
    const result = capFrames([text(0, 700_000), text(1, 700_000), text(2, 5)]);
    expect(result.frames[0]?.text).toHaveLength(700_000);
    expect(result.frames[1]).toMatchObject({ size: 700_000, payloadTruncated: true });
    expect(result.frames[1]?.text).toBeUndefined();
    expect(result.frames[2]?.text).toBe('xxxxx'); // a small one after it still fits
    expect(result.truncated).toBe(true);
  });
});
```
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement**
```ts
/**
 * What History keeps of a session. Both ends, because the end — the last messages before an
 * unexpected close — is what a person comes back for, and a first-N cap loses exactly that.
 */
import type { WsFrame } from './model.js';

export const WS_HISTORY_HEAD = 400;
export const WS_HISTORY_TAIL = 100;
export const WS_HISTORY_MAX_BYTES = 1_048_576;

export interface WsTranscript {
  readonly frames: readonly WsFrame[];
  readonly truncated: boolean;
  readonly omittedFrames: number;
}

export function capFrames(frames: readonly WsFrame[]): WsTranscript {
  const limit = WS_HISTORY_HEAD + WS_HISTORY_TAIL;
  const kept =
    frames.length <= limit ? [...frames] : [...frames.slice(0, WS_HISTORY_HEAD), ...frames.slice(-WS_HISTORY_TAIL)];
  const omittedFrames = frames.length - kept.length;
  let budget = WS_HISTORY_MAX_BYTES;
  let stripped = false;
  const capped = kept.map((frame): WsFrame => {
    if (frame.size <= budget) {
      budget -= frame.size;
      return frame;
    }
    if (frame.text === undefined && frame.base64 === undefined) return frame;
    stripped = true;
    return {
      index: frame.index,
      direction: frame.direction,
      opcode: frame.opcode,
      at: frame.at,
      size: frame.size,
      ...(frame.close !== undefined ? { close: frame.close } : {}),
      payloadTruncated: true,
    };
  });
  return { frames: capped, truncated: omittedFrames > 0 || stripped, omittedFrames };
}
```
- [ ] **Step 4: Run → PASS.** **Step 5: Gate and commit** — `feat(ws): cap a session's transcript at both ends for History`.

---

## Slice S2 — the project format

### Task 5: `kind: websocket` in the model, schema, loader, serialiser and save

**Files:**
- Modify: `packages/engine/src/project/model.ts` — `AnyRequestDef` gains `WsRequestDef`; `Project` gains
  `readonly wsApis: readonly WsApi[]` (JSDoc in the words of `grpcApis`); the empty-project factory gains `wsApis: []`.
- Modify: `packages/engine/src/project/schema.ts` — `wsSettingsSchema`, `wsSavedMessageSchema`
  (`{ id: nonEmpty, name: z.string(), format: z.enum(['text','binary']).default('text'), file: nonEmpty }`),
  `wsRequestFileSchema`, `wsApiFileSchema` (both `z.looseObject`, `kind: z.literal('websocket')`, `definition`
  optional `{ kind: z.literal('asyncapi'), source: nonEmpty, cache: z.boolean().default(true) }`);
  `SUPPORTED_KINDS` gains `'websocket'`; `apiKindOf` returns `'rest' | 'grpc' | 'websocket'`.
- Modify: `packages/engine/src/project/load.ts` — `wsRequestReader` beside `grpcRequestReader`; `LoadedApi`
  gains the third member; `loadApi` becomes a `switch (apiKindOf(document))`; the collector beside
  `grpcApis.push` gains `wsApis`; the returned project gains `wsApis: wsApis.sort(byOrder)`.
- Modify: `packages/engine/src/project/serialize.ts` — `writeWsRequest`, `addWsApiFiles`, and the loop beside
  `for (const api of project.grpcApis)`.
- Modify: `packages/engine/src/project/save.ts:281` — the `APIS_DIR` slug set gains `project.wsApis`.
- Modify: `packages/engine/src/run/select.ts` — a websocket request is never selected; when a selector names
  one, the reason is `WebSocket requests are not runnable from the command line`. Read how the file treats
  what it cannot run today and use that mechanism.
- Test: `packages/engine/test/unit/project/ws-format.test.ts`

**Interfaces:**
- Consumes: Task 2's model and `wsMessageFileName`.
- Produces: `Project.wsApis`; on disk, per request, `<slug>.request.yaml` with
  `messages: [{ id, name, format?, file }]` and one sibling file per message.

- [ ] **Step 1: Failing tests.** Build the project with the in-memory `FsLike` harness the gRPC format test
  uses — find it with `grep -rln "grpcApis" packages/engine/test/unit` and copy its setup. The first test in full:

```ts
it('round-trips a WebSocket API byte-identically', async () => {
  const request = createWsRequest('Feed', {
    id: 'r1',
    url: '/feed',
    subprotocols: ['chat.v2'],
    headers: [{ name: 'x-trace', value: '${trace}', enabled: true }],
    messages: [
      createWsSavedMessage('Subscribe', { id: 'm1', content: '{"op":"sub"}' }),
      createWsSavedMessage('Blob', { id: 'm2', format: 'binary', content: 'AAEC' }),
    ],
  });
  const project = {
    ...emptyProject(),
    wsApis: [createWsApi('Live', { id: 'a1', url: 'wss://live.example.test', requests: [request] })],
  };
  const first = serializeProject(project);
  expect([...first.keys()].filter((k) => k.startsWith('apis/Live/')).sort()).toEqual([
    'apis/Live/api.yaml',
    'apis/Live/requests/Feed.msg-Blob.b64',
    'apis/Live/requests/Feed.msg-Subscribe.json',
    'apis/Live/requests/Feed.request.yaml',
  ]);
  expect(first.get('apis/Live/api.yaml')).toMatch(/^kind: websocket\n/);
  const reloaded = await loadFrom(first);
  expect(reloaded.problems).toEqual([]);
  expect(reloaded.project.wsApis[0]?.requests[0]?.messages.map((m) => m.content)).toEqual(['{"op":"sub"}', 'AAEC']);
  expect(serializeProject(reloaded.project)).toEqual(first);
});
```
  (`emptyProject`, `serializeProject`, `loadFrom` stand for whatever the copied harness calls them.) Then:
  - a project with no WebSocket API serialises to exactly the file map it did before this task — compare
    against the map produced from the same project on `main` (the existing golden, if the harness has one);
  - the message files are claimed: loading reports no stray-file problem;
  - a request whose message file is gone loads that message with `content: ''` and a `missing-body` problem
    naming the file;
  - a message slug of `../../etc` makes `serializeProject` throw the path-safety error (`/path/i`);
  - two messages with the same slug make `serializeProject` throw `duplicate-slug`;
  - renaming the request slug `Feed` → `Ticker` yields the `Ticker.*` paths and none of the `Feed.*` ones (slugs keep their case: the shared `slugify` preserves it);
  - `assertSupportedKind({ kind: 'graphql' }, 'apis/x/api.yaml')` throws
    `apis/x/api.yaml is a "graphql" document, which this build cannot open`, and `{ kind: 'websocket' }` does not throw.

- [ ] **Step 2: Run → FAIL** (type errors first: `wsApis` missing on `Project`). Then run `pnpm typecheck`
  and keep the list of errors the new `Project.wsApis` member raises across the workspace — **that list is
  the work of Tasks 8–13**. Fix only the engine ones now; in `apps/desktop` add `wsApis: []` only where an
  object literal must satisfy `Project`, nothing more.

- [ ] **Step 3: Implement.** `writeWsRequest`:
```ts
/**
 * A WebSocket request as written: each saved message goes to a sibling file, so a JSON message is a
 * JSON file in git. Siblings rather than a directory, because every directory here loads as a folder.
 */
const writeWsRequest: RequestWriter<WsRequestDef> = (files, dir, request) => {
  const messages = request.messages.map((message) => {
    const file = wsMessageFileName(request.slug, message);
    assertPathSegment(file);
    if (files.has(`${dir}/${file}`)) {
      throw new ProjectError('duplicate-slug', `Request "${request.name}" has two messages named "${message.slug}"`, {
        details: { file: `${dir}/${file}` },
      });
    }
    files.set(`${dir}/${file}`, message.content);
    return compact({
      id: message.id,
      name: message.name,
      format: message.format === 'binary' ? 'binary' : undefined,
      file,
    });
  });
  files.set(
    `${dir}/${request.slug}${REQUEST_SUFFIX}`,
    stringifyYaml(
      compact({
        kind: request.kind,
        id: request.id,
        name: request.name,
        order: request.order,
        description: request.description,
        url: request.url,
        query: request.query.length > 0 ? keyValueDocuments(request.query) : undefined,
        headers: request.headers.length > 0 ? keyValueDocuments(request.headers) : undefined,
        subprotocols: request.subprotocols.length > 0 ? [...request.subprotocols] : undefined,
        auth: authDocument(request.auth),
        settings: Object.keys(request.settings).length > 0 ? compact({ ...request.settings }) : undefined,
        messages: messages.length > 0 ? messages : undefined,
      }),
    ),
  );
};
```
  Use the error code the serialiser already uses for a duplicate request slug if it is not `duplicate-slug`.
  `addWsApiFiles` is `addGrpcApiFiles` with `url` and `headers` in place of `target`, `tls` and `metadata`.
  `wsRequestReader` mirrors `grpcRequestReader`, looping over `parsed.messages`: `assertPathSegment(entry.file)`,
  `unclaimed.delete(entry.file)`, read, push `missing-body` when absent, and derive the message slug as
  `` entry.file.slice(`${requestSlug}.msg-`.length, entry.file.lastIndexOf('.')) ``.

- [ ] **Step 4: Run → PASS**, then `pnpm typecheck` clean. **Step 5: Gate and commit** —
  `feat(project): kind: websocket, the fourth container, at formatVersion 3`.

### Task 6: History carries a WebSocket session

**Files:** Modify `packages/engine/src/project/history.ts`; the existing history unit test file gains a block.

**Interfaces — Produces:**
```ts
export interface HistoryWs {
  readonly url: string;
  readonly status?: number;
  readonly protocol?: string;
  readonly closeCode: number;
  readonly closeReason: string;
  readonly closedBy: 'client' | 'server' | 'error';
  readonly counts: WsExchange['counts'];
  readonly frames: readonly WsFrame[];
  readonly truncated?: boolean;
  readonly omittedFrames?: number;
  readonly error?: string;
}
// HistoryEntry.kind?: 'soap' | 'rest' | 'grpc' | 'websocket';   HistoryEntry.ws?: HistoryWs;
/** Applies `capFrames`. */
export function historyWsOf(exchange: WsExchange): HistoryWs;
```
- [ ] **Step 1: Failing tests** — an entry with `kind: 'websocket'` survives a JSONL write and read; an old
  line with no `kind` still reads as SOAP; `historyWsOf` of a 1 000-frame exchange sets `truncated: true` and
  `omittedFrames: 500`, and of a 2-frame one sets neither key; the search haystack (`history.ts:159`)
  matches on `entry.ws?.url` and `entry.ws?.protocol`.
- [ ] **Step 2: Run → FAIL. Step 3:** implement beside `HistoryGrpc`. **Step 4: Run → PASS.**
- [ ] **Step 5: Gate and commit** — `feat(history): a WebSocket session, capped at both ends`.

---

## Slice S3 — a saved request becomes a session

### Task 7: `ws/expand.ts`, `ws/call.ts`, `ws/command.ts`

**Files:** Create the three; Tests `test/unit/ws/expand.test.ts`, `command.test.ts`,
`test/integration/ws/call.test.ts`; Modify `src/index.ts`.

**Interfaces:**
- Consumes: the property expander `grpc/expand.ts` uses (open it; reuse the same function, `PropertyScopes`
  and `UnresolvedRef`); `resolveWsUrl`; the REST auth builder in `rest/auth.ts` that turns an `AuthConfig`
  plus resolved secrets into headers and query rows — WebSocket uses it unchanged.
- Produces:
```ts
export interface WsCallInput {
  readonly serverUrl: string;
  readonly request: Pick<WsRequestDef, 'url' | 'query' | 'headers' | 'subprotocols' | 'settings'>;
  readonly apiHeaders: readonly KeyValueEntry[];
}
export function expandWsInput(
  input: WsCallInput,
  scopes: PropertyScopes,
): { readonly input: WsCallInput; readonly unresolved: readonly UnresolvedRef[] };
export function expandWsMessage(
  text: string,
  scopes: PropertyScopes,
  options: { readonly escape: boolean },
): { readonly text: string; readonly unresolved: readonly UnresolvedRef[] };
/**
 * Headers: API rows first, request rows override by case-insensitive name, then auth.
 * @throws WsError `ws-auth-unsupported` for NTLM, which authenticates a connection WebSocket cannot share.
 */
export function toWsSessionOptions(
  input: WsCallInput,
  material: {
    readonly auth: ResolvedAuth; // the type rest/auth.ts takes — use its real name
    readonly tls?: TlsOptions;
    readonly proxy?: ProxyOptions;
    readonly signal?: AbortSignal;
  },
): WsSessionOptions;
export function wsToCommand(
  options: Pick<WsSessionOptions, 'url' | 'headers' | 'subprotocols'>,
  flags: { readonly insecure?: boolean },
): string;
```
  `wsToCommand` prints a `websocat` line — `websocat -H='name: value' --protocol chat.v2 'wss://…'`, `-k` when
  insecure — quoted with the helper `http/curl.ts` already has. `websocat` is a generic command-line client,
  as `grpcurl` is in `grpc/command.ts`; confirm `pnpm check:banned-terms` accepts it before building on it.

- [ ] **Step 1: Failing tests** — expansion reaches the URL, query values, header values and each
  subprotocol, and reports an unknown `${nope}` once per place it appears; `escape: true` JSON-escapes a value
  substituted into a message; a request header beats an API header whatever the case; Basic, Bearer, an API
  key in a header and an API key in the query each land where REST puts them; NTLM throws
  `ws-auth-unsupported` with a sentence a person can act on; `settings.handshakeTimeoutMs`,
  `maxMessageBytes`, `bindAddress` and `trustInvalid` (→ `tls.rejectUnauthorized: false`) reach the options;
  the command line survives a header value containing `'`. `call.test.ts`: a request with Bearer auth and
  `${room}` in its query reaches `/echo?room=7` on the test server with `authorization: Bearer …` set.
- [ ] **Step 2: Run → FAIL. Step 3:** implement. **Step 4: Run → PASS.**
- [ ] **Step 5: Gate and commit** — `feat(ws): a saved request becomes session options`.

---

## Slice S4 — main process and IPC

### Task 8: Mutations, routing and the project host

**Files:**
- Create: `apps/desktop/src/main/project-ws-mutations.ts` — read `project-grpc-mutations.ts` end to end and
  reproduce its exports for the new container: `locateWsRequest`, `withWsPatch`, `wsAuthChainFor`, and the
  change appliers `add-ws-api`, `update-ws-api`, `delete-ws-api`, `add-ws-request`, `update-ws-request`,
  `duplicate-ws-request`, `delete-ws-request`; plus three gRPC has no twin for — `add-ws-message`,
  `update-ws-message`, `delete-ws-message`, each addressing `{ requestId, messageId }`. Adding slugifies the
  name and de-duplicates the slug with a numeric suffix the way request slugs are de-duplicated.
- Modify: `main/project-mutations.ts`, `main/project-router.ts`, `main/project-host.ts`,
  `main/project-wire.ts`, `main/workspace-service.ts`, `main/unsaved-store.ts`, `main/search.ts`,
  `main/ipc/search.ts`, `main/ipc/api.ts`, `shared/wire-types.ts` (`WsApiWire`, `WsFolderWire`,
  `WsRequestWire`, `WsRequestPatchWire`, `WsSavedMessageWire`, the change schemas), `shared/ipc.ts`.
- Test: `apps/desktop/test/ws-mutations.test.ts` (new); the project-wire and router tests gain a case each.

**Interfaces — Produces:**
```ts
export function locateWsRequest(
  project: Project,
  requestId: string,
): { readonly api: WsApi; readonly folders: readonly WsFolder[]; readonly request: WsRequestDef } | undefined;
export function withWsPatch(request: WsRequestDef, patch?: WsRequestPatchWire): WsRequestDef;
export function wsAuthChainFor(project: Project, requestId: string): AuthConfig[] | undefined;
```
`ProjectHost` gains `wsSend(requestId, draft?)`, `wsTlsFor(requestId)` and `wsMeta(requestId)` beside the
`grpc*` trio, with the same return shapes.

- [ ] **Step 1: Failing tests** — each change applied to a small project and asserted on the resulting
  `wsApis`; folder and move changes reach a WebSocket tree by id; deleting an API removes its endpoint
  override from every environment; a patch carrying `messages` replaces the list; search finds a request by
  URL, by header value and by saved-message text.
- [ ] **Step 2: Run → FAIL. Step 3:** implement; `pnpm typecheck`. **Step 4: Run → PASS.**
- [ ] **Step 5: Gate and commit** — `feat(desktop): WebSocket APIs, requests and saved messages in the project host`.

### Task 9: `resolveWsSend`, the session registry, and the three channels

**Files:**
- Create: `apps/desktop/src/main/ws-send.ts` — the twin of `grpc-send.ts`: draft → server URL under the
  environment (the `resolveTarget` slot, same key) → auth chain → settings ladder → one `expandWsInput` pass.
  ```ts
  export interface WsSendResolution {
    readonly input: WsCallInput;
    readonly unresolved: readonly UnresolvedRef[];
    readonly api: WsApi;
    readonly request: WsRequestDef;
    readonly urlSource: BaseUrlSource;
    readonly auth: AuthConfig;
  }
  export function resolveWsSend(args: ResolveWsSendArgs): WsSendResolution | undefined;
  ```
- Modify: `main/engine-service.ts` —
  ```ts
  private readonly wsSessions = new Map<string, WsSessionHandle>();
  async openWsSession(
    args: { readonly sendId: string; readonly requestId: string; readonly options: Omit<WsSessionOptions, 'signal'> },
    o: { readonly showSecrets?: boolean; readonly onLive?: (event: WsLiveEvent) => void },
  ): Promise<WsExchangeSummary>;
  /** @throws WirebenchError `ws-session-unknown` */
  sendWsMessage(sendId: string, message: { readonly text: string } | { readonly base64: string }): WsFrameWire;
  closeWs(sendId: string, code?: number, reason?: string): { closed: boolean };
  closeAllWs(code: 1001): void;
  ```
  It registers an `AbortController` in the existing `sends` map so `request.cancel` aborts a handshake,
  stores the handle when the handshake succeeds, emits `handshake` / `frame` / `closed`, and deletes both map
  entries in `finally`. `closeAllWs` uses code 1001 only in the row it records; on the wire it calls
  `close(1000, 'going away')`, because an application may not send 1001 (Task 3).
- Modify: `main/engine-wire.ts` — `toWsFrameWire`, `toWsHandshakeWire` (header values redacted unless
  `showSecrets`, through the redactor `toGrpcExchangeSummary` uses), `toWsExchangeSummary`.
- Modify: `shared/wire-types.ts` —
  ```ts
  export const wsLiveEventSchema = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('handshake'), sendId: z.string(), handshake: wsHandshakeWireSchema }),
    z.object({ kind: z.literal('frame'), sendId: z.string(), frame: wsFrameWireSchema }),
    z.object({ kind: z.literal('closed'), sendId: z.string() }),
  ]);
  export type WsLiveEvent = z.infer<typeof wsLiveEventSchema>;
  ```
  plus `requestOpenWsRequestSchema { requestId, sendId, draft? }`, `requestWsSendRequestSchema
  { sendId, requestId, format: 'text' | 'binary', content, expand: boolean }`,
  `requestWsCloseRequestSchema { sendId, code?, reason? }` and their responses.
- Modify: `shared/ipc.ts` — `request.openWs`, `request.wsSend`, `request.wsClose`, `events.ws.live`.
- Modify: `main/ipc/request.ts` — `openWsRequest(service, deps, request, sender)`, shaped like
  `sendGrpcRequest`: unknown id → `ProjectError('unknown-entity')`; unresolved → `ws-unresolved-properties`;
  a prepare stage (TLS identity via `wsTlsFor`, `extraTrustAnchors`, the proxy via
  `deps.project.proxyFor(owner, url)` with the URL mapped to `http(s)` for the lookup, the OAuth2 token) that
  reports `reportSendFailed(… stage: 'prepare')`; then the session; then `recordWs` (Task 10).
  `request.wsSend` expands the content through `expandWsMessage` with the request's scopes when `expand` is
  true, and refuses with `ws-unresolved-properties` rather than sending a literal `${…}`; binary content is
  validated as base64 before it reaches the handle. `request.curl` and the preflight dispatch to the WebSocket path.
- Modify: `main/index.ts` — on `before-quit` and on project close, `service.closeAllWs(1001)`.
- Test: `apps/desktop/test/ws-send-path.test.ts`, `engine-ws-session.test.ts`, `ipc-ws.test.ts`.

- [ ] **Step 1: Failing tests**, against `startTestWsServer` imported the way `grpc-send-path.test.ts`
  imports the gRPC server: a saved request opens; a `wsSend` is echoed and both frames arrive as `ws.live`
  events **before** the invoke resolves (record `resolved` in a flag and assert it was false when each event
  fired — the ordering technique of `streaming.test.ts`); `wsSend` for an unknown `sendId` is refused with
  `ws-session-unknown`; `wsClose` twice answers `{ closed: true }` then `{ closed: false }`; `request.cancel`
  during `/hang` resolves the invoke with `closed.by === 'error'`; an `authorization` header is masked in the
  wire handshake unless secrets are shown; `closeAllWs` closes two open sessions; a message with `${nope}` and
  `expand: true` is refused and nothing reaches the server.
- [ ] **Step 2: Run → FAIL. Step 3:** implement. **Step 4: Run → PASS.**
- [ ] **Step 5: Gate and commit** — `feat(desktop): open a WebSocket session and drive it by sendId`.

### Task 10: The HTTP Log and History

**Files:** Modify `main/ipc/request.ts` (`recordWs`), `main/history-service.ts` (`recordWsSession`, using
`historyWsOf`), `main/failed-exchange.ts`, `main/har.ts`, `main/log-curl.ts`, `main/ipc/log.ts`,
`shared/wire-types.ts` (the log protocol union gains `'ws'`). Tests: `history-service.test.ts`,
`ipc-request-send-failed.test.ts`, `har.test.ts` and `ipc-ws.test.ts` gain blocks.

- The log entry is **the handshake**: method `GET`; the URL as `http(s)://` for filtering with the `ws(s)://`
  original kept for display; the request headers (the raw head when Task 1 found it); status `101` with the
  response headers; the handshake's `durationMs`; TLS. It is written **when the handshake settles**, not when
  the session closes — emit it from the `onHandshake` path through the sink a finished REST exchange uses.
  Find that sink with `grep -n "onExchange\|onSendFailed\|reportSend" apps/desktop/src/main/ipc/request.ts`.
- A refused or failed handshake goes through `reportSendFailed(failedExchangeOf({ protocol: 'ws', … }))`.
- HAR export: a WebSocket row exports as an ordinary entry for the `GET`/`101` pair with
  `_resourceType: 'websocket'` and no `_webSocketMessages` — the log holds the handshake, History the frames.
- `log.resend` refuses a `ws` row with the sentence a gRPC streaming row gets; `log-curl` uses `wsToCommand`.
- History: one entry per session, written on close, failures included.

- [ ] **Step 1: Failing tests** — the log row exists while the session is still open; a 401 produces a failed
  row and a History entry with `closedBy: 'error'`; the HAR shape; the resend refusal; a 1 000-frame session
  writes 500 frames with `omittedFrames: 500`.
- [ ] **Step 2: Run → FAIL. Step 3:** implement. **Step 4: Run → PASS.**
- [ ] **Step 5: Gate and commit** — `feat(desktop): the handshake in the HTTP Log, the session in History`.

---

## Slice S5 — renderer

### Task 11: State — project, drafts, tabs, and the live exchange

**Files:** Modify `renderer/state/project.ts`, `drafts.ts`, `unsaved-drafts.ts`, `editors.ts`,
`workspace-tabs.ts`, `ui-state.ts`, `exchanges.ts`; `renderer/shell/app-shell.tsx` (subscribe once, beside
`subscribeToGrpcLive`). Test: `apps/desktop/test/renderer/ws-live-store.test.ts`.

**Interfaces — Produces** (in `exchanges.ts`, beside the gRPC members):
```ts
export interface WsLiveState {
  readonly handshake?: WsHandshakeWire;
  readonly frames: readonly WsFrameWire[];
  readonly open: boolean;
}
export interface WsExchangeState {
  readonly status: 'idle' | 'connecting' | 'open' | 'closing' | 'closed' | 'error';
  readonly sendId?: string;
  readonly live?: WsLiveState;
  readonly exchange?: WsExchangeSummary;
  readonly error?: WireError;
}
connectWs(requestId: string): Promise<void>;
sendWsMessage(
  requestId: string,
  message: { readonly format: 'text' | 'binary'; readonly content: string; readonly expand: boolean },
): Promise<void>;
disconnectWs(requestId: string, code?: number, reason?: string): Promise<void>;
applyWsLive(event: WsLiveEvent): void;
subscribeToWsLive(): () => void;
```
- `applyWsLive` applies the guard `applyGrpcLive` applies, unchanged in meaning: find the request holding that
  `sendId`; drop the event when none does, when the request has moved to a newer `sendId`, or when its
  exchange has already arrived. `live` is dropped when the invoke resolves.
- `connectWs` while `status` is `connecting` or `open` is a no-op (spec assumption 8).

- [ ] **Step 1: Failing tests** — frames append in order; an event for a superseded `sendId` lands nowhere; an
  event after the exchange arrived lands nowhere; `live` is gone once the exchange is set; `sendWsMessage`
  while closed sets a readable error and invokes nothing; a second `connectWs` while open invokes nothing; a
  draft patch for URL, headers, subprotocols and messages stages and saves like gRPC's.
- [ ] **Step 2: Run → FAIL. Step 3:** implement. **Step 4: Run → PASS.**
- [ ] **Step 5: Gate and commit** — `feat(renderer): WebSocket state, with a live half that leaves when the exchange arrives`.

### Task 12: Explorer, tab host and the API tab

**Files:** Modify `features/explorer/{tree-nodes,explorer-actions,explorer-view,context-menu,drag-drop,explorer-api}.ts(x)`,
`shell/editor-area.tsx`, `features/environments/endpoints-table.tsx`, `features/search/*`,
`commands/register-explorer-commands.ts`, `register-project-commands.ts`, `shared/commands.ts`,
`shared/command-catalog.ts`. Create `features/ws-api/ws-api-tab.tsx` (server URL, default headers, auth,
description — the `grpc-api` tab minus the definition card) and `features/ws-editor/badge.tsx` (**WS**).
Tests: the explorer tree and menu tests gain WebSocket cases; `renderer/ws-api-tab.test.tsx`.

- Node kinds `ws-api` and `ws-request`. *New WebSocket API* asks for a name and a server URL; *New WebSocket
  request* is offered on a WebSocket API and its folders. Drag-and-drop stays inside the API.
- Commands `ws.newApi`, `ws.newRequest`. After adding them run `pnpm docs:commands` (without `--check`) and
  commit the regenerated file with the task.
- The environments endpoints table lists a WebSocket API's server URL in the slot a gRPC target has.

- [ ] **Step 1: Failing tests. Step 2: Run → FAIL. Step 3:** implement. **Step 4: Run → PASS**, and
  `pnpm contrast:check` for the badge.
- [ ] **Step 5: Gate and commit** — `feat(renderer): WebSocket APIs and requests in the explorer, with their API tab`.

### Task 13: The editor — connect bar, tabs, timeline, composer

**Files:** Create under `features/ws-editor/`: `ws-editor.tsx`, `connect-bar.tsx`, `messages-tab.tsx`,
`subprotocols-tab.tsx`, `settings-tab.tsx`, `response-pane.tsx`, `timeline.tsx`, `frame-detail.tsx`,
`composer.tsx`. The Params, Headers and Auth tabs reuse the REST/gRPC components as they are — import, do not
copy. Modify `commands/register-request-commands.ts`, `shell/code-panel.tsx`,
`features/history/history-entry-view.tsx`, `history-view.tsx`,
`features/console/{log-name,log-filter,log-filter-bar,log-row-actions,log-row-menu}.ts(x)`,
`features/request-editor/response-status.tsx`.
Tests: `renderer/ws-timeline.test.tsx`, `ws-composer.test.tsx`, `ws-editor.test.tsx`.

Behaviour, each line a test:
- **Connect bar.** The resolved URL with its source badge (preflight, as gRPC's target). **Connect** when
  idle, closed or failed; **Cancel** while connecting; **Disconnect** while open, with a chevron that opens a
  popover holding *Code* (number, default 1000; an illegal code disables the button and says "1000, or
  3000–4999") and *Reason* (at most 123 bytes, counted in bytes). State chip: connecting / open / closing /
  closed `1000` / failed.
- **Status line.** `101 · permessage-deflate · chat.v2 · 00:42 · ↑3 ↓17 · 4.1 KB`; absent parts are omitted;
  the clock ticks while open.
- **Timeline.** Rows: an arrow (↑ sent, ↓ received, with an `aria-label`), `mm:ss.mmm`, an opcode chip for
  anything but text, size, a one-line preview (binary → its first 16 bytes as hex). Control rows (ping, pong,
  close) show by default; one toggle hides them. Filter: All / Sent / Received, and free text over previews.
  Keyed by `index`; follows the newest row only while scrolled to the bottom; past 1 000 rows it renders a
  window. Build it as a sibling of `MessagesView` — read that component, reuse its scroll-pinning hook if one
  is exported, and do not change it.
- **Frame detail.** Selecting a row opens it under the list: the `prettyFrameText` result in the read-only
  Monaco viewer with a *Raw* toggle; binary as a hex dump with *Copy as base64*; a close row shows the code,
  the code's registered meaning, and the reason. A row with `payloadTruncated` says the payload was not kept.
- **Composer.** A plain textarea under the timeline; a Text/Binary toggle (binary accepts base64 or hex;
  invalid input disables Send and says why); an *Expand properties* checkbox, on by default; **Send**
  disabled unless open. `Mod+Enter` in the composer sends it. A failed send shows its error inline and keeps the text.
- **Messages tab.** The saved messages (add, rename, duplicate, delete, reorder); a Monaco editor whose
  language comes from `prettyFrameText`; a format select; **Send** per message, enabled only while open.
  Edits stage as a draft; `Mod+S` saves.
- **Subprotocols tab.** An ordered list of tokens; a token with a space, a comma or a non-ASCII character is
  refused inline.
- **Settings tab.** Handshake timeout, max message size, escape properties, `trustInvalid` (the red badge, as
  elsewhere), bind address.
- **Handshake tab.** The request head (raw when available; otherwise the headers asked for, with a note that
  the `sec-websocket-*` headers the transport adds are not shown) and the response status and headers.
  **Timing** and **TLS** reuse the existing panes.
- **Shortcuts and commands.** `Mod+Enter` outside the composer connects when closed and sends the selected
  saved message when open. Escape cancels a handshake. `ws.connect`, `ws.disconnect`, `ws.sendMessage`,
  `ws.copyAsCommand`. The Code slide-over shows `wsToCommand`. Regenerate the command docs.
- **History view.** A `websocket` entry renders the same status line and a read-only timeline, with a banner
  "The first 400 and last 100 frames were kept; N omitted" when `truncated`. **Console.** The protocol filter
  gains *WS*; a WS row's name is the URL path; *Resend* is absent from its menu.

- [ ] Steps, component by component (timeline → frame detail → composer → connect bar → tabs → editor →
  history and console): failing test → run → implement → run → `pnpm contrast:check` → gate → commit
  (`feat(ws-editor): the timeline`, and so on). This is the one task with several commits, because a reviewer
  can reject the composer and accept the timeline.

---

## Slice S6 — e2e, docs, gates

### Task 14: e2e, documentation and the success criteria

**Files:**
- Create: `e2e/specs/websocket.spec.ts` — start `startTestWsServer` the way `grpc-streaming.spec.ts` starts
  its server; *New WebSocket API* → *New WebSocket request* `/echo` → Connect → the composer sends `hello` →
  the timeline shows ↑ `hello` then ↓ `hello` → Disconnect with code 3001 and reason `done` → the chip reads
  `closed 3001` → `apis/<slug>/api.yaml` on disk starts `kind: websocket` → the History view lists the
  session → the Console lists one `WS` row with status 101. One axe pass over the open editor.
  **Do not run it locally**; CI runs it.
- Modify: `docs/adr/0007-apis-beside-interfaces.md` — *Update (2026-09-19): WebSocket landed as the fourth
  container*: what it kept (`kind: websocket` in `apis/`, `formatVersion` 3, refusal by name in older builds,
  one branch per layer); the deviation it repeats (`wsApis`, a fourth list); what is new (a request owns
  several sibling files; History's `ws` record is a capped transcript; the transport is container-agnostic on purpose).
- Modify: `docs/success-criteria.md` — rows SC-W1–SC-W6, one per AC, each naming its test files.
- Modify: `docs/roadmap.md` (the Streaming theme's WebSocket item → built), `CHANGELOG.md`, the REST client
  spec's non-goal line (strike WebSocket, point here), this spec's header (`Status: built`).
- Create: a docs-site page beside the gRPC one (`grep -rli grpc docs-site --include='*.md'`), added to the
  sidebar; screenshots only if `pnpm check:docs-images` requires them for a new page.
- `THIRD-PARTY-LICENSES.md` changes only if `pnpm licenses:third-party --check` asks; no dependency was added.

- [ ] Steps: write the e2e spec → write the docs → `WIREBENCH_SKIP_PERF=1 nice pnpm check` →
  `nice pnpm test:perf` → commit `docs(ws): the fourth container, its criteria and its guide` → push →
  open the PR (`Closes #98`; the description ends with its last section, no generated-by footer) → watch CI
  for the e2e result.

---

## Self-review notes

- **Spec coverage.** AC1 → Tasks 1, 3, 7, 9. AC2 → Tasks 2, 3, 13. AC3 → Tasks 5, 7, 8, 9, 13. AC4 → Tasks 3,
  13. AC5 → Tasks 6, 10, 13. AC6 → Tasks 5, 14. The §6 seam for #99/#100 → Task 3 (`session.ts` imports
  nothing from `project/`). CLI refusal → Task 5. Quit closes sessions → Task 9.
- **Where the spec and the platform disagree.** The spec's AC4 says "close with a chosen code"; the WHATWG
  API undici implements allows an application 1000 and 3000–4999 only. The plan enforces that range in the
  engine (`ws-bad-close`) and in the popover, records 1001/1009 intent in the reason text, and Task 14
  amends the spec's AC4 to say so.
- **Deliberate gaps in code detail.** Tasks 8–13 name the gRPC twin to read instead of reproducing ~75 files
  of branch code; each names its files, the signatures it produces and the tests that gate it. Tasks 1–5,
  where the design is new, carry the code.
- **Known unknowns, each with its stop rule.** Refused-handshake status (Task 1 — accept either way);
  request-head observability (Task 1 — degrade the Handshake tab); proxy or client certificate through
  undici's WebSocket (Task 1 — **stop and ask**).
- **Names checked across tasks.** `wsApis`, `WsRequestDef.url`, `WsSavedMessage.content`, `wsMessageFileName`,
  `openWsSession` (engine) vs `EngineService.openWsSession` (desktop, resolves with a summary), `capFrames`,
  `historyWsOf`, `WsCallInput`, `resolveWsSend`, `ws.live`, `request.openWs` / `wsSend` / `wsClose`; error
  codes `ws-bad-url`, `ws-bad-close`, `ws-session-closed`, `ws-session-unknown`, `ws-auth-unsupported`,
  `ws-unresolved-properties`.
