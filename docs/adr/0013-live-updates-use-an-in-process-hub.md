# ADR-0013: Live updates run on an in-process hub, fed by after-commit hooks

- Status: accepted
- Date: 2026-09-26
- Context: issue #74; `docs/specs/2026-09-26-wirebench-server-live-updates-design.md`. Builds on
  [ADR-0009](0009-wirebench-server-is-a-fastify-postgres-process.md) (one server process),
  [ADR-0010](0010-server-identity-is-device-tokens-and-invitations.md) (device tokens),
  [ADR-0011](0011-workspace-roles-are-team-default-plus-grants.md) (who may see a workspace) and
  [ADR-0012](0012-server-sync-merges-on-the-client.md) (the client fetches and merges).

## Context

Server sync polls. Every open server workspace asks `GET …/sync/head` at the user's auto-fetch interval, 60 s
by default. A teammate's push takes up to a minute to show, a demoted or removed member keeps a stale role for
as long, and nobody can see who else has a workspace open. ADR-0008 foresaw a socket behind
`SyncBackend.subscribeRemote`, and the first slice left it a no-op (server-sync assumption 7).

Three things had to be settled: where the events come from, how they reach the app, and where the state that
fans them out lives.

## Decision

- **One WebSocket per signed-in server account**, from the desktop's main process to `GET /api/v1/live`,
  multiplexing every workspace open on that server. `@fastify/websocket` serves it. The device token travels
  in the first message, never in the URL or a header, so no proxy or access log records it.
- **An in-process `LiveHub`** holds the sockets, indexed by session, user and workspace, with the role each
  subscription was admitted at. Nothing is stored: subscriptions and presence exist only in memory.
- **After-commit announcements feed it.** `ServerHooks` gains three lists, `headMoved`, `accessChanged` and
  `sessionEnded`, fired by one `announce(...)` line after the awaited statement or transaction they report.
  `announce` never throws and never awaits. A rolled-back transaction never reaches its line, and a push never
  waits on, or fails because of, the hub.
- **Events are hints; HTTP stays the source of truth.** A message carries no role, email or file content.
  `head`, `access` and `session-ended` each make the desktop run its ordinary fetch, under the existing merge
  and stop-polling rules. Presence is display names and user ids, sent only to sockets subscribed to that
  workspace.
- **Polling stays.** While the socket is connected, auto-fetch waits at least 300 s as a safety net; whenever
  it is not, the user's interval applies unchanged. A server that does not list `live` in its capabilities
  sees no socket attempt.

## Consequences

- A push shows as *to pull* within seconds. A role change, a removal, a deleted workspace and a revoked
  session reach an open app at once, through the *Viewer*, *No access* and *Sign in* states it already has.
- **One server instance, again.** Like the repository lock (ADR-0009, ADR-0012), the hub lives in the
  process: a second replica would hold half the subscribers and miss the other half's announcements. Scaling
  out now needs a fan-out between instances too (PostgreSQL `LISTEN/NOTIFY` or a message bus), beside the
  advisory lock and the shared rate-limit store ADR-0009 names. Until then the safety-net fetch still
  converges every client.
- **A reverse proxy must forward `Upgrade` and `Connection`** for `/api/v1/live`. One that strips them leaves
  the app polling at the user's interval with a *Reconnecting…* dot; nothing else breaks. The server's 30 s
  ping keeps an idle socket inside common proxy timeouts.
- Fourteen one-line fire sites couple identity, teams-access and server-sync to the announcement lists. The
  integration suite fails if one is removed or moved inside its transaction.
- Nothing replays a missed event. A socket that was down during a push reconnects, fetches once, and has
  caught up.
- The desktop gains no dependency: the socket is undici's `WebSocket`, dialled with the same TLS and proxy
  settings as every other server call.

## Alternatives considered

- **Poll faster.** Rejected: every open app would ask `sync/head` every few seconds for events that happen a
  few times an hour, and presence would still need a way to know who is connected.
- **Server-sent events.** Rejected: subscribing and unsubscribing would need HTTP calls beside the stream,
  each carrying the token, and the desktop would need a second streaming client with its own TLS and proxy
  handling. One WebSocket carries both directions, and the engine already dials WebSockets.
- **PostgreSQL `LISTEN/NOTIFY` from the start.** Rejected for now: it pays off only with several replicas,
  which ADR-0009 defers, and it costs a dedicated connection and a payload limit. It is the path when
  multi-instance comes.
- **Announcing inside the transaction**, like the existing `invitationAccepted` hook. Rejected: an
  announcement for a transaction that then rolled back cannot be taken back, and a slow or throwing listener
  would delay or fail the request.
- **The token in the URL** (`/api/v1/live?token=…`). Rejected: URLs end up in proxy and access logs.
- **One socket per workspace.** Rejected: an account would hold as many sockets as open workspaces, the
  per-user socket limit would stop meaning "devices", and presence would be counted per socket instead of per
  session.
