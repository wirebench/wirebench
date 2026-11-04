# ADR-0037: server instances share state through PostgreSQL, and only shares cross between them directly

Date: 2026-11-03 · Status: accepted (2026-11-04, built in #828, #833 and #836) · Design: `docs/specs/2026-10-24-wirebench-hosted-edition-design.md` §5.5, §6,
§20 · Issue: #776, slice 5 #821 · Amends: [ADR-0009](0009-wirebench-server-is-a-fastify-postgres-process.md),
[ADR-0013](0013-live-updates-use-an-in-process-hub.md)

## Context

The server was built as one process (ADR-0009). Four things live in its memory and are only right while there is one
of it:

- the live hub's subscribers and presence (ADR-0013);
- the per-workspace repository lock (ADR-0009, ADR-0012);
- every rate limiter;
- the terminal-share registry, which joins an owner's socket to its viewers' sockets.

Slice 4 made the rest multi-process safe: the scheduler claims with `skip locked`, the alert outbox and the audit
forwarder lease their rows, the sealer takes a try-lock, and the host lease keeps one host per user (§19.9). The
hosted edition needs at least two instances behind a balancer, and a self-hosted Enterprise team may want two for
availability. The four in-memory pieces had to move somewhere every instance can reach.

The options:

1. **PostgreSQL for everything.** `LISTEN`/`NOTIFY` for the hub, advisory locks for the repositories, a table for the
   limiters. No new service to run, back up or secure; the database is already the one thing every instance shares.
   The limits: a notification carries at most 8 000 bytes, a listening connection cannot go through a transaction
   pooler, and a byte stream does not belong in it.
2. **A message bus** (a key-value store with publish and subscribe, or a broker). Faster fan-out and atomic counters,
   but a second stateful service in every multi-instance deployment, with its own failover, credentials and EU
   hosting, for a load the database carries easily.
3. **Route by tenant to one instance.** Every tenant pinned to one node, so nothing needs sharing. It gives up the
   availability the second instance is for, and one large tenant could not be spread.

A terminal share is the one piece that does not fit option 1: it is a byte stream from an owner to viewers that can
sit on two instances, and screen output would load the database and overrun the notification size.

## Decision

- **Instances share state only through PostgreSQL** (option 1):
  - the hub, the host instances, the terminal-share registry, the tenant map and the data-key cache hear each other
    through one `LISTEN`/`NOTIFY` channel per server schema, whose payloads carry ids only. An event too large to
    send becomes a `resync` (a room's presence is cut into parts instead), and a reconnecting listener resyncs every
    room it holds. Events stay hints that an HTTP fetch follows, so nothing replays and nothing is lost for good;
  - a listener is `cluster` (hears every instance), `remote` (hears the others only: the tenant map and the key
    cache, which a local write already refreshed) or `local` (an effect that must happen once, such as an audit
    row);
  - a `pg_notify` that fails three times, or a full queue, leaves a **missed marker**, a tenant-less `resync` the
    peers treat as their own reconnect. After a reconnect or a marker, every instance re-validates the sessions it
    holds against the live device tokens, so a `sessionEnded` it missed cannot leave a revoked user connected;
  - the repository lock is a session advisory lock per `(schema, tenant, workspace)`, behind the in-process queue,
    on a small pool of its own;
  - every rate limiter charged inside a tenant, and the new per-tenant budgets, are token buckets in an unlogged
    table, charged in one statement. The one exception is the `app.` entry's form, charged before a request has a
    tenant: its limiter stays in memory, per instance;
  - a `server_instances` table of heartbeats says which processes are alive.
- **One code path.** A single-instance server runs every one of these too. It costs a statement or two per push and
  per limited request, measured by `pnpm test:perf`, and it means the multi-instance path is the one every test runs.
- **Shares cross directly** (owner ruling, 2026-11-03): a viewer's instance relays the viewer's socket to the
  instance that holds the share, over a second listener on a private address, authenticated by a short-lived HMAC
  token bound to the tenant, share, workspace, viewer and target. The holder also answers the join dialog's info
  that way. This is the only traffic between instances, and the token's key, derived from
  `WIREBENCH_SERVER_SECRETS_KEY`, is why several instances need that key.
- **Stickiness is the balancer's** (owner ruling): the server sets and reads no routing cookie. The host lease
  (§19.9) is what keeps two instances from writing one user's checkout, whatever the balancer does.
- **Who may run several instances:** hosted always; self-hosted on an Enterprise license, by opting in with
  `WIREBENCH_SERVER_INSTANCES=multi` (owner ruling).

## Consequences

- A multi-instance deployment needs nothing beyond PostgreSQL, the shared data volume, a balancer with sticky cookies
  and a private network between instances. The README and the docs say so, with a Traefik example.
- The listening connection and the lock pool must reach PostgreSQL directly, not through a transaction pooler. They
  use the migration URL where one is set, as the server-running lock does.
- A one-instance server makes a few more statements than before. A push gains a lock and an unlock; a sign-in gains a
  bucket charge.
- After a crash the buckets start full, as an in-memory limiter does after a restart. This is the price of an
  unlogged table, and it is the same as today.
- Fan-out stays bounded by PostgreSQL's notification throughput. Payloads hold ids only, and a `captureReceived`
  burst is already coalesced per 250 ms window, so the volume is per push and per capture window, not per byte.
- A balancer health-checks `/readyz`, which answers `503` while an instance starts, while its bus reconnects and
  while it drains. A draining instance releases each host lease before it closes the socket, so the tab's reconnect
  finds the lease free on the next instance.
- The internal listener is a second port. If it is exposed by mistake, the token still refuses anyone without the
  server's secrets key.
- Moving to a broker later (option 2) means swapping the bus and the limiter behind their interfaces. Nothing else
  needs to change.

## Alternatives considered

- **A message bus** (option 2) and **pinning tenants to instances** (option 3), above.
- **Share frames over `NOTIFY`.** No new network path, but frames over 8 000 bytes would have to be split, and heavy
  terminal output would load the database. Not taken (owner ruling).
- **Refusing a cross-instance share join.** The simplest, but it makes sharing unreliable exactly where it is sold.
  Not taken.
- **Per-instance limits divided by the instance count.** No shared store, but it is wrong whenever the balancer's
  spread is uneven, and an attacker who targets one instance gets its whole share. Not taken.
