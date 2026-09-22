# gRPC resend from History — design

Issue #53. Today History resends SOAP entries only. A gRPC entry can be opened and read but not
replayed, and `history.resend` refuses it with `history-resend-unsupported`.

## What a resend sends

A gRPC History entry keeps the service, method, method kind, target, the request messages in send
order (including messages pushed while the call was open), redacted metadata, and the response.
It does not keep the TLS identity, the `.proto` set or unredacted metadata. So a resend combines two
sources:

- **From the saved request, as it is now:** the target under the active environment, TLS,
  metadata, auth, settings and the `.proto` set. This is the same "live copy, never the redacted
  copy" rule that the SOAP resend follows.
- **From the entry:** the service, method and method kind, and the request messages. These are the
  things the entry recorded, and they hold no secrets, because only metadata is redacted.

The call goes through `sendGrpcRequest`, the same path the editor and `log.resend` use. That path
resolves properties, refuses unresolved references, and records a new History entry (on success
and on failure). A resend never changes the saved request.

## Multi-message records

A client-streaming or bidi entry is replayed **as a batch**. Every recorded request message is
sent in its original order as one JSON array, and then the request side is half-closed, which is
the same as a non-interactive send of that array from the editor. Messages that were pushed while
the call was open are included. What is not replayed is the timing and the interleaving with
responses: in the replay, the server sees every message up front.

Unary and server-streaming entries send their single message. A server-streaming resend runs until
the server closes the stream, and its responses land in the new History entry.

If an entry recorded no messages, the resend falls back to the message text as typed
(`request.envelopeXml`). This covers a call that failed before it wrote anything.

## Refusals (typed `WirebenchError` codes)

- `history-resend-orphan`: the saved request no longer exists. The entry lacks the TLS identity and
  the `.proto` set, so it cannot be sent on its own.
- `history-resend-unsupported`: this stays in place for REST and WebSocket entries, and for a gRPC
  entry that has no `grpc` block.
- Errors from `sendGrpcRequest` pass through unchanged, for example `grpc-unresolved-properties`,
  or a method that no longer exists in the `.proto` set.

## Wire

There is one new, additive channel: `history.resendGrpc` takes `{ id }` and returns a
`GrpcExchangeSummary`. `history.resend` keeps its SOAP response type and does not change.

## UI

- The ↻ button on a History row and the entry tab's **Re-send** button are shown for gRPC entries.
  They call `history.resendGrpc`. The result appears as a new History entry, exactly as for SOAP,
  and a failure shows a toast with its error code.
- The "Re-send Last SOAP Request" command is unchanged.

## Out of scope

- A REST resend (#42).
- Diffing two entries.
- Replaying with the original timing.
- Opening the replay in the live stream panel.
