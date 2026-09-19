# Spec: WebSocket request kind

- Status: **approved** 2026-09-19, not yet built
- Date: 2026-09-19
- Issue: #98. Shaped so that #99 (GraphQL subscriptions) and #100 (AsyncAPI import) land on it without
  reshaping it; neither is built here.
- Builds on: the gRPC client design (`docs/specs/2026-09-16-wirebench-grpc-client-design.md`), the gRPC live
  streaming design (`docs/specs/2026-09-18-grpc-live-streaming-design.md`), ADR-0003 (project folder format),
  ADR-0004 (secrets), ADR-0005 (path safety), ADR-0007 (APIs beside interfaces — updated by this spec).

## Assumptions and decisions

Decided with the owner on 2026-09-19:

1. **WebSocket is its own container.** A WebSocket API lives in `apis/<slug>/` with `kind: websocket` at the top of
   `api.yaml` and of every request file, the way gRPC does. In memory a `Project` carries `wsApis` beside
   `grpcApis`, `apis` and `interfaces`. The container has a `definition` slot that stays empty in this spec; #100
   fills it.
2. **The transport is undici's `WebSocket`**, already a dependency. It takes the same TLS and proxy *options*
   `sendHttp` does, built through `createDispatcher` when there is no proxy and through `proxyAgentOptionsFor`
   (with `proxyTunnel: true`) when there is one, so client certificates, the custom CA bundle and
   `trustInvalid` are reused rather than re-implemented. No new runtime dependency.
3. **History keeps a capped transcript.** One entry per session, written when it closes.
4. **The CLI runner is out of scope.** It refuses a `kind: websocket` request with a named reason.

Assumed, correct me if wrong:

5. **Raw WebSocket only.** Socket.IO, STOMP and MQTT-over-WebSocket are not recognised, framed or decoded.
6. **`formatVersion` stays at 3.** An older build meets `kind: websocket` and refuses it by name through
   `assertSupportedKind`, exactly as it did for gRPC. No ADR for a bump is needed; ADR-0007 gains an update note.
7. **No manual ping.** undici answers a server ping itself and does not expose sending one. Pings and pongs that
   arrive are shown; a *Send ping* button is not built.
8. **One connection per request tab.** Connecting again while connected is refused in the UI; the button reads
   *Disconnect*.
9. **UI copy and docs never name other tools.**

---

## 1. Objective

**What.** A WebSocket client inside Wirebench: a container with a server URL, folders and requests; a request
editor that connects, shows every frame on a live timeline, and sends composed or saved messages while the
connection is open; close with a code and reason; the handshake in the HTTP Log and the session in History.

**Why.** Mixed estates carry a WebSocket endpoint or two beside their REST and SOAP services. gRPC already paid
for the multi-message record, the live pane and sending into an open call; this is a request kind over those.

**Who.** An individual developer poking at an endpoint by hand.

**Acceptance criteria** (the issue's, made testable):

- AC1. Connects to `ws://` and `wss://` with request headers, query parameters, subprotocols, every shared auth
  kind that is a header or query value (Basic, Bearer, OAuth2, API key; NTLM refused with a readable error, as
  gRPC does), the resolved proxy, a client certificate and the custom CA bundle.
- AC2. The timeline lists every frame with direction, arrival time and size. Text and binary frames are told
  apart; binary shows hex and a base64 copy. A text frame that parses as JSON or XML is pretty-printed, with the
  raw text one toggle away.
- AC3. While connected, the composer sends a text or binary (base64 or hex input) message. Saved messages are
  stored with the request, named, and sent with one click. `${…}` property references expand in the URL,
  headers, query parameters, subprotocols and message text at send time.
- AC4. *Disconnect* closes with a chosen code (default 1000) and reason. The code is 1000 or in 3000–4999: the
  range the WebSocket API lets an application send, which the transport enforces; any other is refused in the
  popover with that sentence. The close frame (either side's), and
  every ping and pong, appear on the timeline as control rows.
- AC5. The handshake appears in the HTTP Log as one entry: the `GET` with its headers, the `101` (or the refusal
  status) with its headers, timing and TLS. A failed handshake appears as a failed send. The session appears in
  History when it closes.
- AC6. `kind: websocket` loads and saves with `formatVersion: 3`; a project without one is byte-identical to
  before; ADR-0007 records the fourth container.

## 2. Tech stack

TypeScript, Node 24, pnpm workspace. Engine: `undici@^8` `WebSocket` plus `node:diagnostics_channel`
(`undici:websocket:open|close|socket_error|ping|pong`, each payload carrying the `websocket` instance to
correlate on), `zod` schemas, `yaml`. Desktop: Electron, React, the existing IPC `registerHandler`/`emitEvent`.
Tests: vitest, Playwright e2e. No new dependency; the test server is in-house over `node:http` `upgrade` (a
minimal RFC 6455 server in `test/helpers`: text, binary, ping, close only) — if that proves larger than ~200
lines, adding `ws` as a **dev** dependency is an ask-first.

## 3. Commands

```
Dev:            pnpm dev
Build:          pnpm build
Gate (commit):  WIREBENCH_SKIP_PERF=1 pnpm check
Gate (push):    pnpm test:perf
Unit/integ:     pnpm test
One file:       pnpm vitest run packages/engine/test/integration/ws/session.test.ts
e2e (CI only):  pnpm build && xvfb-run -a pnpm test:e2e
Banned terms:   pnpm check:banned-terms
Command docs:   pnpm docs:commands --check
```

## 4. Concepts and data model

- **WebSocket API** — name, **server URL** (`ws://`/`wss://`; `http(s)://` accepted and mapped), default
  headers, default auth, optional `definition` (unused here).
- **Folder** — the shared folder.
- **WebSocket request** — a path (joined to the server URL) or an absolute URL, query parameters, headers,
  subprotocols (ordered list), auth, settings (handshake timeout, max message size, `trustInvalid`, bind
  address, property escaping) and **saved messages**.
- **Session** — one connection from handshake to close. **Frame** — one timeline row.

```
apis/<slug>/
  api.yaml                         kind: websocket, name, url, headers, auth?, definition?
  requests/
    <folder-slug>/folder.yaml
    <request-slug>.request.yaml    kind: websocket, path|url, query, headers, subprotocols, auth, settings,
                                   messages: [{ id, name, format: text|binary, file }]
    <request-slug>.msg-<message-slug>.(json|xml|txt|b64)
```

A saved message lives in its own file so a JSON payload diffs as JSON, the rule REST bodies already follow. The
files are **siblings of the request file, not a subdirectory**: every directory under `requests/` loads as a
folder, so a `<slug>.messages/` directory would appear in the explorer as one. The extension follows the content
(`json` when the text parses as JSON, `xml` when it parses as XML, else `txt`); a binary message is stored as
base64 text in `.b64`, because the serialiser's file map holds strings.
Environments override the server URL under the API's slug — the slot a base URL and a gRPC target use.

```ts
// packages/engine/src/ws/model.ts
export interface WsFrame {
  readonly index: number;
  readonly direction: 'sent' | 'received';
  readonly opcode: 'text' | 'binary' | 'ping' | 'pong' | 'close';
  readonly at: number; // ms since the session opened
  readonly size: number; // payload bytes
  readonly text?: string; // text frames
  readonly base64?: string; // binary, ping, pong
  readonly close?: { readonly code: number; readonly reason: string };
}

export interface WsExchange {
  readonly kind: 'websocket';
  readonly url: string;
  /** Request line and headers, status, response headers, protocol, extensions, timings, TLS. */
  readonly handshake: WsHandshake;
  readonly frames: readonly WsFrame[];
  readonly closed: { readonly code: number; readonly reason: string; readonly by: 'client' | 'server' | 'error' };
  readonly counts: {
    readonly sent: number;
    readonly received: number;
    readonly bytesSent: number;
    readonly bytesReceived: number;
  };
}
```

## 5. Project structure

```
packages/engine/src/ws/
  model.ts        types, factories, browser-safe
  session.ts      openWsSession — the container-agnostic transport
  call.ts         callWs — resolves a WsRequestDef (expansion, auth, URL join) and opens a session
  expand.ts       ${…} expansion over url, headers, query, subprotocols, message text
  url.ts          server URL + path + query → ws(s) URL; http(s) mapping
  pretty.ts       JSON/XML detection for a text frame (reuses json/ and xml/)
  command.ts      Copy as Command line
  browser.ts      → subpath @wirebench/engine/ws
packages/engine/src/project/   schema, load, save, serialize, paths, history: the websocket branch
packages/engine/test/{unit,integration}/ws/, test/helpers/test-ws-server.ts
apps/desktop/src/main/ipc/request.ts          request.openWs, request.wsSend, request.wsClose
apps/desktop/src/shared/{ipc,wire-types}.ts   ws.live event, wire types
apps/desktop/src/renderer/state/exchanges.ts  WsExchangeState with `live`
apps/desktop/src/renderer/features/ws-editor/ editor, connect strip, tabs, timeline, composer, badge
apps/desktop/src/renderer/features/ws-api/    the API tab
e2e/specs/websocket.spec.ts
docs/adr/0007-…md (update note), docs/success-criteria.md (SC-W rows), docs/roadmap.md, CHANGELOG.md, docs-site page
```

## 6. Engine

`openWsSession(options, hooks)` is the only thing that touches undici, and it knows nothing about projects:

```ts
export interface WsSessionHooks {
  onHandshake?(handshake: WsHandshake): void;
  onFrame?(frame: WsFrame): void; // every direction, every opcode, in order
  onClosed?(exchange: WsExchange): void;
}
export interface WsSessionHandle {
  send(data: string | Uint8Array): void; // throws ws-session-closed once closing
  close(code?: number, reason?: string): void; // idempotent
  readonly isOpen: boolean;
  readonly done: Promise<WsExchange>; // resolves on close, however it came
}
```

- Options: url, headers, subprotocols, the dispatcher inputs `sendHttp` already takes (proxy, keystore, CA,
  `trustInvalid`, bind address), handshake timeout, max message size, `AbortSignal`.
- The exchange records what was actually sent, as gRPC's does. `done` always resolves with an exchange — a
  refused handshake or a socket error is a *result* with `closed.by: 'error'` and the HTTP status if there was
  one; only a bad option rejects.
- Diagnostics-channel subscribers filter on `payload.websocket === this socket`, and unsubscribe on close.
- **This seam is what #99 and #100 use**: #99 opens a session with subprotocol `graphql-transport-ws` from a
  GraphQL request and speaks its protocol through `send`/`onFrame`; #100 wraps `onFrame` with a schema check and
  adds a marker field to the row. Neither needs the WebSocket container.

**Plan task 1 is a spike** that proves, against the test server, through a `ProxyAgent` and with a client
certificate: custom headers reach the server, the `open` channel yields the 101 headers, ping and pong publish,
and a 401 handshake yields a status. Replaying a refused handshake with a second plain HTTP request to read its
status is **not** acceptable (it would hit the server twice); if undici does not surface it, record what its
error carries and note the gap here.

## 7. IPC and main

Same pattern as `grpc.live`:

- `request.openWs({ requestId, sendId })` stays pending for the life of the session and resolves with the
  `WsExchange`, so History, the HTTP Log and Problems are fed from one place.
- `ws.live` one-way event: `handshake` / `frame` / `closed`, correlated by the renderer-generated `sendId`.
- `request.wsSend({ sendId, text | base64, expand })` and `request.wsClose({ sendId, code, reason })` resolve
  against a registry of open handles in `EngineService` beside the gRPC one. Unknown `sendId` →
  `ws-session-unknown`; closing an already-closed session answers `{ closed: false }`.
- `request.cancel` aborts a session in handshake; `request.curl` dispatches to `ws/command.ts`.
- `project.mutate` gains `*-ws-api`, `*-ws-request` and `*-ws-message` changes; folder and move changes dispatch
  by id. App quit and project close close every open session with 1001.
- HTTP Log: one entry per handshake, written when the handshake settles, protocol column `WS`. History:
  `HistoryEntry.kind` gains `'websocket'` with an optional `ws` record — url, handshake status, protocol, close,
  counts, and a capped transcript, binary as base64. The cap keeps both ends, because the end of a session —
  the last messages before an unexpected close — is what a person returns to History for: at most **500 frames,
  the first 400 and the last 100**, and **1 MB of payload** in total. Past 1 MB an oversized frame keeps its row
  and loses its payload (`payloadTruncated: true`, its true `size` kept) rather than being dropped, so the shape
  of the conversation survives. The handshake is stored beside the frames, not among them, so the cap never touches it; the close frame is a
  session's last frame, so it is always within the kept tail, and as a row without a payload the byte budget
  never strips it. An entry
  that hit either limit carries `truncated: true` and `omittedFrames`, the count left out of the middle.

## 8. Renderer

- Explorer: `ws-api` and `ws-request` nodes, a **WS** badge, drag-and-drop, rename, duplicate, delete; *New
  WebSocket API* and *New WebSocket request*.
- `ws-editor`: path line; strip with the resolved URL (and where it came from) and **Connect** / **Disconnect**
  (code and reason in a small popover); a state chip — connecting, open, closing, closed `1000`. Tabs:
  **Messages** (saved messages: list, Monaco editor, format, *Send* enabled only while open), **Params**,
  **Headers** (request rows, API and transport rows greyed), **Subprotocols**, **Auth**, **Settings**.
- Response side: status line — `101 · permessage-deflate · chat.v2 · 00:42 · ↑3 ↓17 · 4.1 KB` — then
  **Timeline** (rows: arrow, time, opcode chip for non-text, size, one-line preview; selecting a row opens it
  pretty-printed; filter by direction and free text; control rows togglable, on by default), **Handshake**,
  **Timing**, **TLS**. A composer under the timeline: a plain textarea, text/binary toggle.
- State: `WsExchangeState.live` holds the frames while open and is dropped when the exchange arrives;
  `applyWsLive` applies the same sendId guard as `applyGrpcLive`. The timeline reuses `MessagesView`'s keyed,
  follow-only-at-bottom list; past 1 000 rows it windows.
- Shortcuts: `Mod+Enter` connects when closed and, when open, sends the composer if it has focus, else the
  selected saved message; `Mod+S` saves; Escape cancels a handshake. Commands: `ws.connect`, `ws.disconnect`,
  `ws.sendMessage`, `ws.copyAsCommand`, `ws.newApi`, `ws.newRequest`. Search finds a request by URL, header and
  saved-message text.

## 9. Code style

Match the gRPC module: `readonly` data, factories over classes, errors as named codes on the engine's error
type, a result rather than a throw for anything the server did.

```ts
/** Refuses politely once the session is closing, the way a half-closed gRPC stream does. */
function send(data: string | Uint8Array): void {
  if (socket.readyState !== WebSocket.OPEN) {
    throw new WsError('ws-session-closed', 'the connection is closed');
  }
  socket.send(data);
  record({ direction: 'sent', opcode: typeof data === 'string' ? 'text' : 'binary', payload: data });
}
```

Every `kind` branch is a `switch` over the union, so the compiler lists the places the fourth member needs.

## 10. Testing strategy

- **Unit** (`packages/engine/test/unit/ws/`): URL join and scheme mapping, expansion, pretty detection, frame
  record and caps, command line, schema round trip, byte-stable save, rename touching the request file and its
  message files, path safety on message slugs, the older-build refusal message.
- **Integration** (`…/integration/ws/session.test.ts` against `test-ws-server.ts`): text and binary echo,
  headers and query reaching the server, subprotocol negotiation and mismatch, server ping shown with the pong,
  client close code and reason arriving, server-initiated close, abrupt socket drop, 401 handshake, handshake
  timeout, abort, `wss` with the custom CA, client certificate, `trustInvalid`, through the test proxy, max
  message size, send-after-close refused.
- **Desktop** (`apps/desktop/test/`): mutations, the `openWs`/`wsSend`/`wsClose` registry including unknown and
  superseded `sendId`, the live store guard, timeline and composer components, history record and cap, HTTP Log
  entry, quit closes sessions.
- **e2e** (CI only, never run locally while the owner works): create API → connect → send → see echo →
  disconnect → files on disk → History entry; axe over the editor.
- SOAP, REST and gRPC suites stay green unchanged. Criteria land in `docs/success-criteria.md` as SC-W1–SC-W6,
  one per AC.

## 11. Boundaries

- **Always:** one commit per plan task after `WIREBENCH_SKIP_PERF=1 pnpm check` is green; commit as the owner
  with no trailers; ADR-0005 path safety on every new file path; secrets only through the secret store; command
  docs and the docs site updated in the same change as the feature they describe.
- **Ask first:** any new dependency (runtime or dev); a `formatVersion` bump; changing `sendHttp`,
  `createDispatcher` or the gRPC live plumbing beyond adding a sibling; any change to the shared `MessagesView`
  that alters gRPC behaviour.
- **Never:** name another tool in code, docs or UI copy; merge the HTTP Log with History; run Electron e2e
  locally; build Socket.IO/STOMP/MQTT framing, AsyncAPI import, GraphQL subscriptions, SSE, the CLI step,
  auto-reconnect, scripted replies, or resend/diff from History for WebSocket entries.

## 12. Success criteria

Done when AC1–AC6 each have a passing automated test named in `docs/success-criteria.md`, `pnpm check` and CI
e2e are green, a project saved by this build without a WebSocket API is byte-identical to one saved before, and
ADR-0007, the roadmap, the changelog and the docs site describe the fourth container.

## 13. Open questions

1. Does a refused handshake (401/403) surface its status and headers through undici? The task-1 spike answers
   it. Decided 2026-09-19: whatever it finds is accepted — if the status is not surfaced, the HTTP Log entry
   shows the request side and the error text, the gap is noted here, and a second transport is not added for it.

### 13.1 What the task-1 spike found (undici 8.10.2)

- **A refused handshake exposes no HTTP status or headers through the WebSocket API.** `error` fires with an
  empty `message` and an internal `TypeError` on `error.error` (an undici implementation detail, not a stable
  field to branch on); no status, no response headers, nothing reachable from the `WebSocket` object says why
  the handshake failed. `close` is not guaranteed to fire afterward — once a prior WebSocket has already opened
  against the same origin, the pooled connection means a subsequent refused handshake's `close` never arrives,
  only `error` does. The session therefore treats `error` before open as the terminal signal for a failed
  handshake and never waits on `close` to follow it. The HTTP Log entry for a refusal shows the request side and
  a generic failure, matching decision 1 above.
- **The raw request head and the TLS socket are observable**, one layer below the WebSocket object: undici's
  `undici:client:sendHeaders` diagnostics channel fires for the handshake's underlying HTTP request, carrying
  the raw request head (including the `sec-websocket-*` headers undici adds) and the connection's socket. This
  is what the Handshake tab reads from.
- **A proxied WebSocket needs `proxyTunnel: true`.** undici's `WebSocket` rewrites `ws:`/`wss:` to `http:`/
  `https:` before dispatching, and `ProxyAgent` only CONNECT-tunnels an `http:` request when `proxyTunnel: true`
  is set; without it, the request is forward-proxied instead, which a plain forward proxy has no `upgrade`
  handler for and the handshake hangs. `createDispatcher` does not set `proxyTunnel`, so the session does not
  reuse it for the proxy case — it builds its own agent straight from `proxyAgentOptionsFor(proxy, { tls,
  localAddress }, false, { proxyTunnel: true })`, `new ProxyAgent(...)` from undici. `createDispatcher` stays
  unchanged and is used only when there is no proxy.

Settled 2026-09-19: saved messages are separate files (§4); the History cap is 500 frames, both ends kept, and
1 MB (§7); no manual ping and one connection per tab stand.
