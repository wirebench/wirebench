# Wirebench Server: `live-updates` — design

Issue: #74, second slice · Date: 2026-09-26 · Status: draft 2026-09-26, design approved by the owner in
conversation · Module: `live-updates` of `docs/specs/2026-09-24-wirebench-server-capability-map.md`

- Intent: `docs/intent/wirebench-server-teams.md` (live updates and presence were out of the first slice).
- Builds on:
  - `docs/specs/2026-09-24-wirebench-server-host-design.md`: `ServerContext`, `MetaRegistry`, shutdown
    (§3.7) and the single-instance assumption (assumption 1).
  - `…-identity-design.md`: device tokens, sign-out, device removal, `AccountService`.
  - `…-teams-access-design.md`: `resolveRole`, `effectiveRole`, grants, membership, default roles.
  - `…-server-sync-design.md`: `ServerBackend`, `SyncService`, the stop-polling codes and `resume()`
    (§3.4, §3.5). This module retires its assumption 7.
- Decision recorded here (2026-09-26): **live updates run on an in-process hub, fed by after-commit
  hooks, over one WebSocket per signed-in server account.** ADR-0013 records it and its
  single-instance consequence.

## Revisions against the code

The owner's decisions stand. Where the merged code made one impossible as worded, the row names the
conflict and the resolution this spec adopts. Every later section already reflects them.

| # | Conflict in the code | Resolution used here |
| --- | --- | --- |
| R1 | `SyncBackend.subscribeRemote(onChange: () => void)` (`apps/desktop/src/main/sync/backend.ts:49-50`) carries no data, so it cannot deliver a head, a presence list or the socket state. `SyncService` never calls it, and every implementation is a no-op (`git-backend.ts:530`, `folder-backend.ts:93`, `server-backend.ts:482`). | Widen it to `subscribeRemote(listener: (event: RemoteEvent) => void): () => void` (§5.3). Git and folder stay no-ops. `SyncService` subscribes in `start()` and unsubscribes in `stop()` and on stop-polling. |
| R2 | "access → `probe()`": `ServerBackend.probe()` is local only (`server-backend.ts:257-274`, sync spec §3.1), so it cannot see a role change or a removal. | An `access` event runs `SyncService.fetch()`. `GET /sync/head` returns the role, and a `404` becomes `sync-access-removed` through the existing mapping: the decision's "re-probe over HTTP". |
| R3 | `ServerHooks` (`packages/server/src/context.ts:28-35`) is documented as work that runs *inside* the caller's transaction, awaited, where a throw rolls the caller back. The new hooks fire *after* commit and must never fail a push. | They stay in `ServerHooks`, as decided, typed as announcements with their own runner: synchronous, not awaited, every throw caught and logged (§3.2). The doc comment is amended to name both kinds. |
| R4 | Two role changes live in identity, not teams-access: the server-admin flag and disabling a user (`identity/routes/users.ts:62-70`). | Identity fires `accessChanged({ userId })` when the server-admin flag changes. Disabling already revokes every token, so it fires `sessionEnded`. |
| R5 | Node's global `WebSocket` is usable in Electron 44's main process: running the Electron 44.3.0 binary reports `process.type` `browser`, Node 24.20.0 and `typeof WebSocket` `function`. But the WHATWG constructor takes no TLS or proxy options. A server trusted through Wirebench's CA bundle, or reached through the configured proxy, would therefore work over HTTP (`ServerClient` uses `mainHttpOptions`, `apps/desktop/src/main/index.ts:137-146`) and never over the socket. | The socket uses undici's `WebSocket`, which the engine already depends on (`packages/engine/src/ws/session.ts:13`, `undici ^8`). It is the same WHATWG API plus a `dispatcher` built from the same TLS and proxy options (§5.2). No new dependency, and no `ws` package on the desktop. |
| R6 | The decided server messages include no reply to a client `ping` and no "authenticated" acknowledgement. The WHATWG API cannot see protocol pings, so the client could neither detect a dead server nor tell *connecting* from *connected*. | Two server messages are added: `ready` answers a valid `auth`, and `pong` answers `ping` (§3.1). |

## Assumptions

1. **One server process** (host assumption 1). The hub lives in memory, so a second instance would miss
   the other's events. ADR-0013 records this beside the in-process repository lock.
2. **One open workspace per app today.** `WorkspaceService` holds one `current` workspace
   (`workspace-service.ts:532`), so a `LiveClient` has at most one subscription in practice. The
   protocol multiplexes anyway.
3. **`@fastify/websocket` 11 supports Fastify 5.** It is not in the local pnpm store. The registry
   metadata for 11.3.1 lists `fastify ^5.0.0` among its devDependencies and depends on `ws ^8.16.0`,
   `fastify-plugin ^6` and `duplexify`, all MIT-licensed. The plan's first task installs it against
   `fastify ^5.12.5` (`packages/server/package.json`) and confirms this.
4. **Node's WebSocket client sends no `Origin`.** undici appends one only when a global origin was set
   (`undici/lib/web/fetch/util.js:268-270` in 7.29.1 and 8.10.2), and Wirebench never sets one.
5. **A reverse proxy forwards `Upgrade`.** The host spec leaves TLS to a proxy. One that strips
   `Upgrade` leaves the app polling with a *Reconnecting…* dot, and the docs say how to fix it.

---

## 1. Objective

**What.** When a teammate pushes to a server workspace, everyone who has it open learns about it within
seconds. Role changes, removed access, a deleted workspace and a revoked session take effect at once
instead of on the next poll. The Sync panel shows who else has the workspace open.
- **Server:** a `live` module serving `GET /api/v1/live` as a WebSocket, and an in-process `LiveHub` fed
  by three new after-commit hooks.
- **Desktop:** a `LiveClient` per signed-in server account in main, and `ServerBackend.subscribeRemote`
  finally implemented. `SyncService` fetches on events and polls less while the socket is up.

**Why.** Sixty-second polling makes a push feel slow, and a demoted or removed member keeps a stale role
for up to a minute. Seeing who else is in a workspace answers "is anyone else editing this?" before a
conflict does.

**Who.** Every member of a team on a server that advertises `live`. Git and folder shares are unchanged.

**User stories.**
- As an editor, I push, and my teammate's badge shows *1 to pull* within seconds, even with auto-fetch at
  ten minutes.
- As a team admin, I demote an editor or remove a member. Their badge reads *Viewer* or *No access* at
  once.
- As a member, when an admin revokes my other laptop, it shows *Sign in* and stops listening.
- As a member, the Sync panel tells me "Also here: Ana, Ben". When my network drops, the dot reads
  *Reconnecting…*, polling falls back to my interval, and one fetch catches up afterwards.

**Non-goals (this module).** Presence per request or per edit. Live refresh of the Team dialog's lists.
Merging or pulling on an event. Multi-instance fan-out (a bus, `LISTEN/NOTIFY`). A browser client.
Events for git or folder shares. New renderer error-code entries.

## 2. Concept model

- **Live socket.** One WebSocket from the desktop's main process to one server. Its first message binds
  it to one device token (the *session*).
- **Subscription.** A socket's interest in one workspace, admitted at role viewer or above. The hub
  records the role it saw.
- **Announcement.** An after-commit hook call: `headMoved`, `accessChanged` or `sessionEnded`. It is
  fire-and-forget, and a rolled-back transaction never reaches the line that makes it.
- **Presence.** The distinct users with a subscribed socket on a workspace, as `{ id, name }`. It is
  derived from subscriptions and never stored.
- **Live state.** Per server account on the desktop: `connected` (authenticated and subscribed),
  `connecting` (opening, authenticating or backing off) or `off` (no `live` capability, signed out, or
  no open workspace on that server).
- **Safety-net interval.** 300 s: the auto-fetch delay while connected, never shorter than the user's.

## 3. Behaviour

### 3.1 Protocol

`GET /api/v1/live`, upgraded to a WebSocket. Every frame is one UTF-8 JSON text message; binary frames
are refused. The schemas are in `packages/engine/src/server-api/live.ts` (§4).

```ts
// client → server
{ type: 'auth', token: string }            // first message, within 10 s; DEVICE_TOKEN_PATTERN
{ type: 'subscribe', workspaceId: string }  // TEAMS_ID_PATTERN
{ type: 'unsubscribe', workspaceId: string }
{ type: 'ping' }
// server → client
{ type: 'ready' }                                                   // auth accepted (R6)
{ type: 'head', workspaceId: string, head: string }                 // a push committed
{ type: 'access', workspaceId: string }                             // role may have changed; ask over HTTP
{ type: 'presence', workspaceId: string, users: { id: string, name: string }[] }
{ type: 'refused', workspaceId: string, code: 'teams-workspace-not-found' | 'live-too-many-subscriptions' }
{ type: 'session-ended' }                                           // then close 4401
{ type: 'pong' }                                                    // answers ping (R6)
```

- **Auth.** The token travels only in the first message, never in the URL or a header. A valid token
  answers `ready` and binds the socket to the session (token id, user id, display name). The close codes
  below cover the failures.
- **Subscribe** calls `effectiveRole(db, userId, workspaceId)` (`teams/roles.ts:70-73`). `none` answers
  `refused … teams-workspace-not-found`, as HTTP does, so an id reveals nothing. Any other role is
  recorded. A repeat is a no-op, the 201st of a session is refused with `live-too-many-subscriptions`, and
  *unsubscribe* is silent.
- **`head`** goes to every subscriber of the workspace except the pushing session's sockets.
- **`access`** carries no role: HTTP stays the single source of truth. It goes only to subscriptions
  whose effective role changed, including to `none`. A `none` subscription is dropped after the message.
- **`presence`** goes to the new subscriber on every subscribe. It goes to every subscriber when the
  workspace's distinct user list changes: a user's first socket arriving, their last leaving, or a
  subscription dropped. A second device of the same user changes nothing for the others. The list is
  sorted by name, then id, and includes the recipient, whom the desktop removes.
- **`session-ended`** goes to every socket of an ended session, each then closed `4401`.
- **Unknown types.** The desktop ignores a server message `type` it does not know, for forward
  compatibility. The server closes `4400` on a client message it cannot parse.

| Close | When | Desktop reaction |
| --- | --- | --- |
| `1000` | The desktop closed it (no open workspace there, sign-out, quit) | none |
| `1001` | Server shutting down | reconnect with back-off |
| `1009` | A client message over 4 KiB (`maxPayload`) | reconnect with back-off, logged |
| `1011` | Unexpected server error on this socket | reconnect with back-off |
| `4400` | Malformed or out-of-order message, or a binary frame | reconnect with back-off |
| `4401` | Bad token, session ended, or the token's maximum age reached | token check, no reconnect (§3.4) |
| `4408` | No `auth` within 10 s | reconnect with back-off |
| `4429` | The user already has 32 sockets | reconnect after 60 s |

### 3.2 Server hooks and where they fire

`ServerHooks` (`context.ts:33-35`) gains three announcement lists. The live module pushes onto them in
`register()`, as teams-access pushes `invitationAccepted` (`teams/module.ts:37`).

```ts
export interface HeadMoved { readonly workspaceId: string; readonly head: string; readonly tokenId: string }
export interface AccessChanged { readonly workspaceId?: string; readonly teamId?: string; readonly userId?: string }
export type SessionEnded = { readonly tokenId: string } | { readonly userId: string; readonly exceptTokenId?: string };
export type Announcement<E> = (event: E) => void;
export interface ServerHooks {
  readonly invitationAccepted: InvitationAcceptedHook[];   // in-transaction, awaited (unchanged)
  readonly headMoved: Announcement<HeadMoved>[];           // after commit, never awaited (R3)
  readonly accessChanged: Announcement<AccessChanged>[];
  readonly sessionEnded: Announcement<SessionEnded>[];
}
/** Calls each listener in order; a throw is logged at warn and swallowed. Never throws. */
export function announce<E>(listeners: readonly Announcement<E>[], event: E, log: FastifyBaseLogger): void;
```

An `AccessChanged` sets at least one field. A subscription is affected when its workspace is
`workspaceId`, or belongs to `teamId`, and, if `userId` is set, when its user is `userId`.

Every call sits **after** the statement or transaction it reports has resolved, on the success path.
A throw inside the transaction skips it: that is what "a rolled-back transaction announces nothing"
means in code.

| Hook | Site (after it resolves) | Event |
| --- | --- | --- |
| `headMoved` | `sync/routes/commits.ts:48-52`: the `withLock` whose `update-ref` compare-and-swap moved main (`sync/commit-store.ts:514-523`); before the `201` | `{ workspaceId, head, tokenId: caller.tokenId }` |
| `accessChanged` | `teams/routes/access.ts:66-69` (set grant) and `:79` (delete grant) | `{ workspaceId }` |
| | `teams/routes/workspaces.ts:154-159`, only when `body.defaultRole` was given | `{ workspaceId }` |
| | `teams/routes/workspaces.ts:173-180`, workspace delete | `{ workspaceId }` |
| | `teams/routes/members.ts:62` (add), `:88-94` (role), `:106-114` (remove) | `{ teamId, userId }` |
| | `identity/routes/users.ts:62-70`, when `body.serverAdmin` was given (R4) | `{ userId }` |
| `sessionEnded` | `identity/routes/auth-local.ts:46-47`, sign-out | `{ tokenId: caller.tokenId }` |
| | `identity/routes/me.ts:85`, device removed | `{ tokenId: id }` |
| | `identity/routes/me.ts:51-54`, password change | `{ userId, exceptTokenId: caller.tokenId }` |
| | `identity/routes/users.ts:62-70`, when `body.disabled === true` | `{ userId }` |
| | `identity/invitations.ts:134-141`, a `reset` accepted | `{ userId }` |

**Not announced:** a new user accepting a team invitation (`teams/routes/invitations.ts:29-35`), who has
no socket yet; team create, rename and delete (a team with workspaces cannot be deleted,
`teams/routes/teams.ts:90`); workspace creation; lazy expiry (`identity/guard.ts:57-59`) and the sweep
(`identity/sessions.ts:29-37`), which the hub's own deadline covers; and the admin CLI
(`identity/cli.ts`), a separate process that revokes no token.

### 3.3 The hub

`packages/server/src/live/hub.ts`, one per server, created in the module's `register()`.

- **Indexes.** `bySocket: Map<Socket, SocketState>`, where `SocketState` is `{ tokenId, userId, name,
  deadline, subs: Map<workspaceId, WorkspaceRole> }` (or `pending` before `auth`), plus `byWorkspace`,
  `byUser` and `byToken`, each a map to `Set<Socket>`.
- **Auth** calls identity's `callerForToken` (§5.1). It makes the same checks as `authenticate`
  (`identity/guard.ts:48-71`): hash lookup, revoked, expired (lazily deleted), disabled, and the
  once-a-minute touch. It also returns the display name and the token's `createdAt`.
  - The user's 33rd authenticated socket closes `4429`.
  - A timer closes the socket with `session-ended` and `4401` at `createdAt + tokenMaxMs`.
  - Idle expiry cannot reach a connected desktop: its safety-net fetch touches the token every 300 s,
    against a 30-day idle limit.
- **`headMoved`** sends `head` to `byWorkspace`, minus the sockets of `tokenId`.
- **`accessChanged`** runs in the background, so the announcement returns at once:
  1. It finds the affected subscriptions. A `teamId` scope needs one query, the new `teams/repo.ts`
     `workspaceIdsOfTeam`, intersected with `byWorkspace`.
  2. It re-resolves each distinct (user, workspace) pair once with `effectiveRole`.
  3. For each subscription whose recorded role differs, it sends `access`. It then drops the
     subscription when the new role is `none`, and records the new role otherwise.
  4. It sends `presence` where a drop changed a user list.

  A failed query is logged and ends that check, and the desktop's safety-net fetch still converges.
- **`sessionEnded`** sends `session-ended` to the sockets of `tokenId`, or to those of `userId` minus
  `exceptTokenId`, and closes each `4401`.
- **Send.** `socket.send` inside `try`. A socket that is not open, or whose send throws, is terminated and
  removed from every index, and presence updates. One dead socket never affects another.
- **Heartbeat.** Every 30 s the hub sends a protocol ping to each socket, and terminates any socket that
  did not answer the previous one. A client `ping` gets `pong`.
- **Limits.** Client messages are at most 4 KiB (`maxPayload: 4096`, closing `1009`); server messages are
  not capped, since a presence list grows with the team. A session has at most 200 subscriptions across
  its sockets, and a user 32 authenticated sockets. The 10 s timer bounds unauthenticated ones.
- **Shutdown.** `closeAll()` closes every socket `1001` and clears the indexes. Later announcements are
  no-ops.

### 3.4 Desktop behaviour

- **Lifetime.** `LiveClients` (main) keeps one `LiveClient` per server URL.
  - It opens when that account is signed in (`AccountService.tokenFor`, `account-service.ts:275-279`)
    **and** an open workspace's `ServerBackend` has subscribed through it.
  - It closes `1000` on the last unsubscribe, on sign-out or removal (`AccountService.onChange`,
    `account-service.ts:113-118`), and on quit (`before-quit`, `index.ts:604`).
  - An `onChange` showing a new `tokenRef` reconnects with the new token.
- **Capability.** Before connecting, it calls `ServerClient.meta(url)` (`server-client.ts:131-144`).
  Without `live` in `capabilities`, or when the upgrade answers `404`, it reports `off`, makes no attempt,
  and polling is exactly as today.
- **Connect.**
  1. The URL is `/api/v1/live` on the stored origin, with `https:`→`wss:` and `http:`→`ws:`. An `http:`
     origin exists only where the operator allowed it (`config.ts:284-285`).
  2. The client sends `auth`. On `ready` it subscribes every workspace and reports `connected`.
  3. It sends a `ping` every 30 s. No `ready`, or no `pong`, within 10 s closes and reconnects.
- **Back-off.** `min(60 s, 1 s × 2^n)`, times a random factor in [0.5, 1]. `n` resets on `ready`, and
  `4429` waits 60 s.
- **`4401`.** The client runs the normal token check, `AccountService.refresh(url)`
  (`account-service.ts:299-321`), which marks the account signed out when the server confirms
  `identity-unauthenticated`. It then reports `ended`, and does not reconnect until the account is
  signed in again with a new token.
- **Events.** The client drops the account's own `userId` (`ServerAccount.userId`) from `presence`, and
  turns `refused` into `access`. `ServerBackend.subscribeRemote` maps each message to a `RemoteEvent`
  (§5.3). A `head` becomes `changed` only when it differs from both the stored `knownHead` and
  `base.head`, so a client's own echo is free.
- **`SyncService` reacts:**

  | Event | Reaction |
  | --- | --- |
  | `changed` | `fetch()` (`sync-service.ts:255-261`): *behind* updates, as a timer fetch does. Nothing merges; pull, merge and conflicts follow the existing rules. |
  | `access` | `fetch()` (R2). A promotion pushes waiting commits. `404` → `sync-access-removed` and a disabled account → `sync-account-disabled`, both stop-polling codes (`server-backend.ts:80-84`). |
  | `ended` | `fetch()`. The account is now signed out, so the backend throws `sync-signed-out` without a network call: the existing stop-polling path. |
  | `presence` | stored and emitted |
  | `live` | stored and emitted, and the fetch timer re-armed. `connected` also runs one catch-up `fetch()`. |

  While a fetch is queued and not started, further events queue nothing.
- **Polling.** `armFetchTimer` (`sync-service.ts:697-719`) waits `max(autoFetchSeconds, 300)` s while
  `connected`, and `autoFetchSeconds` otherwise (the offline back-off is unchanged). An
  `autoFetchSeconds` of 0 arms no timer in either state, but events still fetch.
- **Stop-polling closes the subscription.** `stopPolling()` (`:722-728`) also unsubscribes, and
  `resume()` (`:366-376`) subscribes again before its fetch. A closed subscription clears `presence` and
  reports `live: 'off'`.
- **Status.** `syncStatusWireSchema` (`shared/wire-types.ts:4340-4359`) gains two optional fields, which
  `SyncService` lays over the backend's status, as it does `held`:
  - `presence?: { id, name }[]`, the others on this workspace;
  - `live?: 'connected' | 'connecting' | 'off'`, for a server share only.
- **Renderer.**
  - The Sync panel shows "Also here: Ana, Ben" under its header: up to five names, then "+N".
  - The badge shows a small dot while `connected` (tooltip "Live") or `connecting` (tooltip
    "Reconnecting…").
  - Nothing is shown per request, and `sync-codes.ts` gains no entries.
- **Git and folder shares:** no socket and no new fields.

### 3.5 Errors

The close codes (§3.1) and the reactions above cover the socket. The remaining cases:

| Situation | Server | Desktop |
| --- | --- | --- |
| Foreign `Origin` | `403 live-origin-refused`, before the upgrade | unreachable (the app sends none) |
| Subscribe without access | `refused … teams-workspace-not-found` | `fetch()` → `sync-access-removed` |
| Too many subscriptions | `refused … live-too-many-subscriptions` | that workspace keeps polling at the user's interval; logged once |
| A throw in an announcement | logged at warn; the request still succeeds | none |
| Proxy strips `Upgrade` | a plain HTTP answer | `connecting`, polling at the user's interval |

`live-origin-refused` and `live-too-many-subscriptions` are functions in `live/errors.ts`. The desktop
shows neither to the user.

## 4. Data model and wire

- **Wire.** `packages/engine/src/server-api/live.ts`, exported from the engine index, holds:
  - `liveClientMessageSchema` and `liveServerMessageSchema`: discriminated unions on `type`, as in §3.1;
  - `livePresenceUserSchema`;
  - `LIVE_CLOSE`, the close codes;
  - `LIVE_LIMITS`: `maxMessageBytes: 4096`, `maxSubscriptionsPerSession: 200`, `maxSocketsPerUser: 32`,
    `authTimeoutMs: 10_000` and `heartbeatMs: 30_000`.

  They are plain zod (ADR-0009), with tokens on `DEVICE_TOKEN_PATTERN` and ids on `TEAMS_ID_PATTERN`.
  `LiveClient` parses the server union plus a catch-all for unknown types.
- **Storage.** None: no tables, no migration, no client files. Subscriptions and presence live in the
  hub's memory, and the live state in `LiveClients`.
- **Status.** The two optional fields of §3.4, which older renderers ignore.

## 5. Architecture

### 5.1 Server

- `live/module.ts`: `liveModule()`, appended to `BUILTIN_MODULES` after `syncModule()` (`modules.ts:10`).
  `register()` does four things:
  1. registers `@fastify/websocket` into the shared `/api/v1` scope (`server.ts:142-156`), with
     `options: { maxPayload: 4096 }` and a `preClose` that calls `hub.closeAll()` and then closes the
     `ws` server;
  2. adds `GET /live` with `{ websocket: true }` and a route `onRequest` origin check;
  3. pushes the hub's listeners onto `ctx.hooks`;
  4. calls `ctx.meta.addCapability('live')` (`context.ts:62-64`).

  Identity's `onRequest` (`identity/module.ts:72`) still runs before the upgrade. It finds no
  `Authorization` header and leaves `request.caller` unset.
- `live/hub.ts` (§3.3), `live/socket.ts` (the per-socket loop, the auth timer, parsing) and
  `live/errors.ts`.
- `context.ts`: the announcement lists and `announce()`, empty lists from `serverHooks()`, the amended
  doc comment (R3), and `'live-updates'` added to `ServerModule.name` (`:84`).
- `identity/guard.ts`: `callerForToken({ db, settings, now }, token)`, extracted from `authenticate`,
  which calls it. It returns `{ caller, displayName, tokenCreatedAt }` and throws the same errors. The
  live module builds `settings` with `identitySettings(ctx.config)`, as teams-access does
  (`teams/module.ts:30`).
- `teams/repo.ts`: `workspaceIdsOfTeam(db, teamId)`.
- The fourteen fire sites of §3.2, one `announce(...)` line each.
- **Shutdown.** `serve.ts` `close()` (`:225-252`) is unchanged: `app.close()` (`:239`) runs `preClose`,
  which closes every socket `1001` before the in-flight wait, and so before `repos.drain()` (`:248`). A
  push finishing during the drain announces into a closed hub.

### 5.2 Engine

- `server-api/live.ts` (§4).
- `ws/connect.ts`: `connectWebSocket(url, { tls?, proxy? }): { socket: WebSocket; dispose(): Promise<void> }`
  (R5).
  - It builds the dispatcher as `openWsSession` does (`ws/session.ts:253-271`: a tunnelling `ProxyAgent`
    for a proxy, `createDispatcher` for TLS), and `openWsSession` is refactored to share that code.
  - It returns undici's `WebSocket`, with no frame recording and no History.

### 5.3 Desktop main

- `sync/backend.ts` (R1):

  ```ts
  export type RemoteEvent =
    | { readonly kind: 'changed' } | { readonly kind: 'access' } | { readonly kind: 'ended' }
    | { readonly kind: 'presence'; readonly users: readonly { id: string; name: string }[] }
    | { readonly kind: 'live'; readonly state: 'connected' | 'connecting' | 'off' };
  subscribeRemote(listener: (event: RemoteEvent) => void): () => void;
  ```
- `live/live-client.ts`: one socket, the §3.4 state machine and back-off.
  - Its dependencies are `connect`, `tokenFor`, `refresh`, `meta`, `userId`, `setTimer` and `random`.
  - It is electron-free, since the server package's contract run imports `ServerBackend` (sync spec O4).
- `live/live-clients.ts`: the per-URL registry, with `subscribe(url, workspaceId, listener): () => void`,
  an `AccountService.onChange` listener and `closeAll()` for quit.
- `sync/server-backend.ts`: `ServerBackendDeps.live?: Pick<LiveClients, 'subscribe'>`, and
  `subscribeRemote` as in §3.4. Without `live` it stays a no-op, which keeps the contract suite unchanged.
- `sync/create-backend.ts`: `ServerSyncServices` gains `live?`.
- `sync/sync-service.ts`: the subscription lifecycle, `onRemote` with its coalescing flag, the two
  status fields, and `LIVE_SAFETY_NET_SECONDS = 300` in `armFetchTimer` (§3.4).
- `index.ts`: builds `liveClients` from `mainHttpOptions`, `accountService` and `connectWebSocket`,
  passes `live` in `server:` (`:243`), and calls `liveClients.closeAll()` in `before-quit` beside
  `closeAllWs()`.
- `shared/wire-types.ts`: the two status fields. There is no new IPC: status already travels through
  `events.sync.statusChanged` (`index.ts:310-312`).

### 5.4 Desktop renderer

- `features/sync/sync-panel.tsx`: the "Also here" line.
- `features/sync/sync-badge.tsx`: the dot and its tooltip.
- Both use type-only imports from `shared/wire-types.ts` (the CSP rule).

## 6. Security

- **The token** travels in the first message only: never in a URL, a query or a header, so proxies and
  access logs never see it. The server's redaction already covers `token` keys (`server.ts:26-43`), and
  the desktop never logs messages.
- **`wss:`** is used whenever the origin is `https:`: the scheme comes from the stored origin and is never
  downgraded.
- **Role checks.** Every subscribe uses the same `effectiveRole` as every HTTP route, and a socket that
  lost access is dropped before anything else is sent to it.
- **Presence** is names and user ids only, never emails. It goes only to sockets subscribed to that
  workspace, which all hold at least viewer.
- **Origin.** An upgrade whose `Origin` is present and differs from `config.publicUrl` is refused `403`,
  which blocks browser pages. The desktop sends none (assumption 4).
- **Sessions end at once** on revocation, and at the token's maximum age.
- **Limits** as in §3.3, with a 10 s auth timer and a 30 s heartbeat.
- **No write path.** The socket changes nothing: every action stays an HTTP call behind its guard.
- **A push never depends on the hub.** `announce` swallows throws, and it runs after the ref moved.

## 7. Tech stack

- **Server:** `@fastify/websocket` ^11 (MIT; brings `ws` ^8 and `duplexify`) and `@types/ws` (dev). The
  only alternative is hand-rolling RFC 6455. `THIRD-PARTY-LICENSES.md` is regenerated, because the
  container image ships server dependencies (`scripts/third-party-licenses.ts:14`).
- **Desktop:** nothing new (R5).
- **Tests:** the engine's hand-rolled `packages/engine/test/helpers/test-ws-server.ts` (`startTestWsServer`,
  `:105`) gains a message hook and a `send` control. It is the in-test server for `LiveClient` and the
  base of the e2e fake's `/live`.

## 8. Commands

None.

## 9. Project structure (new or changed)

```
packages/engine/src/server-api/live.ts, src/ws/{connect,session}.ts, src/index.ts
packages/engine/test/helpers/test-ws-server.ts                 # message hook, send
packages/server/package.json                                   # @fastify/websocket, @types/ws
packages/server/src/live/{module,hub,socket,errors}.ts
packages/server/src/{context,modules}.ts
packages/server/src/identity/{guard,invitations}.ts, identity/routes/{auth-local,me,users}.ts
packages/server/src/teams/repo.ts, teams/routes/{access,workspaces,members}.ts
packages/server/src/sync/routes/commits.ts
packages/server/test/unit/live/{hub,socket,announce}.test.ts
packages/server/test/integration/live/**                       # real sockets vs PostgreSQL
packages/server/test/helpers/live.ts
apps/desktop/src/main/live/{live-client,live-clients}.ts
apps/desktop/src/main/sync/{backend,server-backend,create-backend,sync-service,git-backend,folder-backend}.ts
apps/desktop/src/main/index.ts, src/shared/wire-types.ts
apps/desktop/src/renderer/features/sync/{sync-panel,sync-badge}.tsx
apps/desktop/test/live/{live-client,live-clients}.test.ts
apps/desktop/test/sync/{sync-service,server-backend}.test.ts, test/sync/fake-server-backend.ts
e2e/helpers/fake-server.ts, e2e/specs/server-live.spec.ts
docs/adr/0013-live-updates-use-an-in-process-hub.md
docs/specs/2026-09-24-wirebench-server-{capability-map,host-design}.md
docs/collaborate.md, docs-site/src/content/docs/guides/shared-workspaces.mdx, packages/server/README.md
THIRD-PARTY-LICENSES.md
```

The host spec amendment removes "WebSockets and live updates" from its non-goals (§1) and adds the socket
close to §3.7.

## 10. Code style

The same as the earlier modules. Error codes are `live-*`, one function each in `live/errors.ts`. Only
`live/` sends on a socket. The hub reaches the database only through `callerForToken`, `effectiveRole`
and `workspaceIdsOfTeam`. Each fire site is one line after the awaited work:

```ts
const result = await repos.withLock(workspaceId, async () => {
  if (!(await repos.exists(workspaceId))) throw workspaceNotFound();
  return env.store.appendCommits(workspaceId, body.parent, body.commits, author);
});
// main has moved: a rejected or failed push never reaches this line (§3.2).
announce(env.ctx.hooks.headMoved, { workspaceId, head: result.head, tokenId: request.caller!.tokenId }, request.log);
return reply.code(201).send(result);
```

## 11. Testing strategy

- **Engine unit:** the live schemas both ways, where an off-pattern token or id is refused and an
  unknown server `type` passes the client's catch-all; `connectWebSocket` against `startTestWsServer`
  over TLS with a test CA.
- **Server unit:**
  - `announce`: order is kept, and a throwing listener is logged while the rest run.
  - The hub with fake sockets: `head` skips the pushing session; presence is deduped per user; an access
    re-check messages only changed roles and drops `none`; team- and user-scoped changes;
    `sessionEnded` by token and by user; both limits; dead-socket removal; the max-age deadline;
    `closeAll`.
- **Server integration** (PostgreSQL, a server listening on port 0, Node's global `WebSocket` client):
  - **Auth:** valid → `ready`; bad, revoked or expired → `4401`; silent → `4408` (injectable timer);
    a first message that is not `auth` → `4400`; a 5 KiB message → `1009`.
  - **Origin:** another site's `Origin` (a raw `node:http` upgrade) → `403`; no `Origin` → accepted.
  - **Subscribe:** a stranger is refused; a viewer is admitted and gets `presence`.
  - **Push:** editor A pushes; B gets `head` with the new id and A gets nothing.
  - **Rolled back announces nothing:** a `409 sync-push-rejected` push; a member role change refused by
    the last-admin rule; a grant for a non-member (`notAMember`). The last two fail inside their
    transaction.
  - **Access:** viewer → editor sends `access` to that user only; a member removal drops the
    subscription and updates the others' `presence`; a workspace delete drops everyone; a server-admin
    flag change sends `access` (R4).
  - **Sessions:** sign-out, device removal, a password change (other devices only), a disabled user and
    an accepted reset each end exactly the right sockets.
  - **Capability and shutdown:** `capabilities` lists `live`; `close()` sends `1001` before
    `repos.drain()` resolves, and a push in flight completes.
- **Desktop unit:**
  - `LiveClient` against `startTestWsServer`: no `live` means no connection; subscribe after `ready`;
    back-off and jitter bounds (fake timers, seeded `random`); reset on `ready`; `4429` waits 60 s; a
    `pong` timeout reconnects; `4401` calls `refresh` and waits for a new token; self removed from
    `presence`; unknown types ignored; `1000` on the last unsubscribe.
  - `LiveClients`: one client per URL, closed on sign-out.
  - `ServerBackend.subscribeRemote`: a known head is silent, a new one gives `changed`, and `refused`
    gives `access`.
  - `SyncService`: `changed` bursts coalesce into one fetch; an `access` fetch getting `404` stops
    polling and unsubscribes; `ended` gives `sync-signed-out` with no network call; `connected` gives a
    catch-up fetch and the 300 s floor; `connecting` restores the user's interval at once; auto-fetch 0
    arms no timer while events still fetch; `resume()` re-subscribes; git statuses have no new fields.
  - Renderer: the "Also here" line with none, three and seven names ("+2"), and the dot per state.
- **e2e** (fake server with `/live`, all three OSes, auto-fetch at 600 s in both profiles):
  - A pushes, and B shows *1 to pull* within 5 s. Each Sync panel names the other.
  - `setRole` to viewer plus `access` → B reads *Viewer* within 5 s.
  - `revoke(token)` plus `session-ended` → *Sign in*, with no further `/live` connection.
  - A fake with `capabilities: ['sync']` sees no `/live` request.
- **Manual (owner):** two machines against the container image behind a TLS reverse proxy, before the
  release. The result is recorded in the PR.

## 12. Boundaries

Extends the earlier modules' §12.

- **Always:** announce only after the commit or the ref move, on the success path; check the role on
  every subscribe and re-check on every access change; keep the token out of URLs, headers and logs;
  keep `LiveClient`, `LiveClients` and `ServerBackend` free of `electron`; poll whenever the socket is not
  `connected`; keep HTTP the source of truth for roles and heads.
- **Ask first:** multi-instance fan-out; per-request presence; merging or pulling on an event; live Team
  dialog refresh; any write over the socket; raising the limits; a browser client.
- **Never:** let an announcement fail or delay a request; send for a workspace a socket did not subscribe
  to with a role; put a role, an email or file content in a message; accept a token after the first
  message; skip the stop-polling path on `session-ended`.

## 13. Success criteria (done when all are true)

1. With auto-fetch at ten minutes, a push from one profile shows as *to pull* in the other within 5 s,
   and both profiles name each other in the Sync panel.
2. A role change, a removal, a workspace delete, a sign-out elsewhere and a revoked device reach an open
   app within 5 s, through the existing *Viewer*, *No access* and *Sign in* states. Stop-polling closes
   the subscription.
3. A rolled-back transaction or a rejected push announces nothing, proven by the three integration cases.
4. Polling runs at the 300 s safety net while connected and at the user's interval otherwise, and every
   reconnect fetches once.
5. A server without `live` sees no socket attempt, and the app polls exactly as before.
6. Shutdown closes every socket `1001` before the repository drain.
7. `WIREBENCH_SKIP_PERF=1 pnpm check` is green, including `licenses:third-party --check` and
   `check:banned-terms`, and the e2e spec passes on all three OSes.
8. ADR-0013 is written. The capability map, the host spec, `docs/collaborate.md`, the docs site and the
   server README describe live updates, presence, the single-instance rule and the proxy `Upgrade`
   requirement.

## 14. Migration and compatibility

- An older server has no `live`, so a newer app polls as today; an older app never opens a socket.
- `syncStatusWireSchema` gains optional fields only. `subscribeRemote` is internal, and every
  implementation changes with it.
- The new `ServerHooks` lists default to empty; the admin CLI's `serverHooks()` (`identity/cli.ts`) has
  no hub, so announcing there is a no-op.
- No migration and no new environment variable.

## 15. Risks

- **Single instance.** A second replica would split subscribers. ADR-0013 and the README repeat the host
  rule, and the safety-net polling still converges.
- **Proxies.** A proxy that strips `Upgrade` degrades the app to polling with a *Reconnecting…* dot. The
  30 s heartbeat outlasts common idle timeouts, and the docs give the proxy settings.
- **Missed events.** A socket that is down during a push misses the `head`. The reconnect fetch and the
  safety net cover it, and nothing relies on delivery.
- **Access re-check load.** One `effectiveRole` query per distinct subscribed user, in the background.
- **Stale presence names** until the next reconnect after a display-name change: accepted.
- **Hook coupling.** Fourteen one-line fire sites across three modules. An integration test fails if one
  is removed or moved inside its transaction.

## 16. Decisions (formerly open questions)

1. Scope: **push and workspace-level presence**. No per-request presence, and no Team dialog refresh.
2. On a push: **fetch under the existing rules**; polling drops to a 5-minute safety net while connected.
3. Events: **head and access** (role change, access removed, workspace deleted, session revoked).
4. Transport: **one WebSocket per signed-in server account in desktop main**, multiplexing workspaces,
   over an in-process hub fed by `ServerHooks`.
5. Authentication: **the first message, within 10 s**, never the URL.
6. Server library: **`@fastify/websocket`**.
7. Desktop client: **a WHATWG WebSocket in main**, with no new desktop dependency (R5 names undici's).
8. Capability name: **`live`**.
