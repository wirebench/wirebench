# gRPC live streaming and interactive bidirectional send

**Date:** 2026-09-18
**Status:** Built
**Builds on:** [`2026-09-16-wirebench-grpc-client-design.md`](2026-09-16-wirebench-grpc-client-design.md),
[`2026-09-17-grpc-server-reflection-design.md`](2026-09-17-grpc-server-reflection-design.md)

## 1. The problem

The gRPC client sends every streaming shape, but it shows none of them as they happen. A
server-streaming call that takes a minute shows nothing for that minute and then everything at
once, which is the one thing a stream is not. And a bidirectional call is sent in batch form — the
message text is written, the request side is half-closed, the replies are read — so there is no way
to say something, read the answer, and say the next thing. That is the whole point of a
bidirectional method, and it was the gap the gRPC spec named first among its boundaries.

Both are one problem underneath: the transport knew what was happening, and nobody was listening.

## 2. What was built

Two things, together, because the second is unusable without the first — pushing a message into a
call you cannot see is typing into the dark.

- **A call reports itself while it runs.** The initial metadata, then each response message as it
  is parsed, decoded against the method's response type. The response pane raises its tab strip as
  soon as the call opens and appends messages as they arrive.
- **A call can be held open.** For a method whose client streams, *Open stream* starts the call and
  leaves the request side open; a composer under the response pane sends one more message at a
  time, and *Half-close* ends the sending without ending the call — the server may still be
  answering.

## 3. Engine: three hooks, no new transport

`sendGrpc` gained three optional callbacks, and nothing else about it changed:

- `onHeaders(headers, httpStatus)` — fired from the existing `'response'` handler.
- `onMessage(bytes, index)` — fired from the single `messages.push(...)` site inside `'data'`,
  already the one point every decompressed message passes through, in order.
- `onOpen(handle)` — opts into interactive mode. Without it, `sendGrpc` writes every message and
  half-closes immediately, exactly as it always has; with it, the request side stays open and the
  handle's `write` / `end` / `isOpen` drive it.

`callGrpc` mirrors them with the schema applied: its `onMessage` hands over a decoded
`GrpcResponseMessage` (the standalone `decodeResponseMessage` the batch path already used), and its
`onOpen` hands over a handle whose `send` takes JSON *text* and encodes it against the request type.
The renderer therefore never sees bytes, and the codec stays in one place.

Two details worth keeping:

- **The record grows with the call.** `exchange.request.messages` and `rawRequest` are built from
  what was actually sent, not from the input, so a message pushed by hand is in the raw bytes and
  in `requestMessages` — the exchange records the conversation, not its opening line.
- **A closed stream refuses politely.** `handle.write` after a half-close (or after the call has
  ended) throws `grpc-stream-closed` rather than writing to a dead stream. `end` is idempotent.

A call still ends the way it always did: the server ends the stream, the deadline passes, or the
signal aborts. Half-closing is not required to finish — a server may answer and end while the
client still holds its side open.

## 4. IPC: events out, invokes in

`request.sendGrpc` **stays open and still resolves with the whole exchange**, so history, the HTTP
Log, the Problems entries and every existing caller are untouched. Alongside it:

- **`grpc.live`**, a one-way event carrying `open` / `headers` / `message` / `closed`, correlated
  by the renderer-generated `sendId`. This is the import-progress precedent: a token in the invoke,
  events pushed from `emitEvent(sender, …)` while it runs. `sendGrpcRequest` in
  `main/ipc/request.ts` now takes the `sender` argument `registerHandler` was already passing it and
  it was discarding.
- **`request.grpcPush`** and **`request.grpcHalfClose`**, ordinary invokes keyed by that same
  `sendId`, resolved against a registry of open handles in `EngineService` beside its existing
  `sends: Map<string, AbortController>` — which is how `request.cancel` has always addressed a send
  in flight. A push naming a call that is not open is refused with `grpc-stream-unknown`; a
  half-close for one answers `{ closed: false }` rather than throwing, since "already closed" is
  the outcome the caller wanted.

## 5. Renderer: a live half, and the guard that matters

`GrpcExchangeState` gained `live`: the messages so far, the initial metadata, what has been pushed,
and whether the request side is open. It is present while `status` is `sending` and **dropped when
the exchange arrives** — the finished exchange holds the same messages, and keeping both would let
the pane show a message twice.

The correlation is the guard. Events name a `sendId` and nothing else, so `applyGrpcLive` finds the
request holding that id and drops the event when there is none, when that request has moved on to a
newer send, or when its call has already finished. Every event-driven write goes through that one
check, which is the same rule the awaited reply has always applied after its `await`.

`MessagesView` now keys by arrival index *and* content, so React reuses the rows it painted rather
than rebuilding the list on each message, and follows the newest message only while the reader is
already at the bottom — scrolling up to read one pins the view there.

## 6. What this does not do

- **No streaming in History.** A history entry records the finished exchange, as it did.
- **No interactive mode for a unary or server-streaming method.** There is nothing to push into a
  call whose client side is one message, so *Open stream* is offered only where the client streams.
- **The composer is a plain textarea**, not the Monaco editor of the Message tab: a line of a
  conversation, typed and sent, rather than a document kept between calls. Completion in the
  message editor was built next (`2026-09-18-grpc-message-completion-design.md`) and did not reach
  here: the composer has no model of its own to register against.
- **No flow control.** A push writes immediately; the HTTP/2 window is Node's to manage.

## 7. Success criteria

See `docs/success-criteria.md`, row SC-G8.
