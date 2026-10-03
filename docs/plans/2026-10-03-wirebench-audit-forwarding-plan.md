# Audit forwarding to syslog or HTTPS — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Wirebench Server on Enterprise forwards every committed audit event to one destination its operator configures: RFC 5424 syslog over TCP or TLS, or an HTTPS endpoint that receives JSON batches. Forwarding never fails or slows the audited action, survives restarts and outages, and delivers each event at least once.

**Architecture:** A transactional outbox. When forwarding is configured, the audit hook inserts the event's id into `audit_forward_queue` in the same transaction as the event, so only committed events are queued and none is lost on a crash. A background forwarder in the `audit-log` module claims queued events oldest first in batches, sends them through a `ForwardSink` (syslog or HTTPS), and deletes the queue rows only after the sink accepts them. Without the `audit-log` feature the forwarder pauses; the queue keeps filling and retention bounds it through a cascading foreign key.

**Tech Stack:** TypeScript on Node 24, Fastify, Postgres (`pg`), `node:net` / `node:tls` for syslog, `fetch` or `node:https` for HTTPS, zod 4, Vitest 5.

**Spec:** `docs/specs/2026-10-01-wirebench-server-audit-log-design.md` (§1.2 named syslog or HTTP push as out of the first slice) and issue #209. Owner decisions (2026-10-03, popup): forwarding is an **Enterprise** feature, the same gate as reading; the first version supports **syslog over TCP or TLS, and HTTPS**. The rest are rulings made while planning.

## Global Constraints

- **Configuration** (`packages/server/src/config.ts`, in both the zod schema and the documented variable list):
  - `WIREBENCH_SERVER_AUDIT_FORWARD_URL`, optional. Accepted schemes: `syslog+tcp://host:port`, `syslog+tls://host:port`, `https://…`, and `http://…` only when the host is a loopback address (`localhost`, `127.0.0.0/8`, `::1`), for local collectors and tests. Anything else is a config error at start, phrased without the value. Unset means no forwarding: nothing is queued.
  - `WIREBENCH_SERVER_AUDIT_FORWARD_TOKEN`, optional, `secret: true`. HTTPS only, sent as `Authorization: Bearer <token>`. With a syslog URL it is a config error.
  - `WIREBENCH_SERVER_AUDIT_FORWARD_CA_FILE`, optional. A PEM bundle **added** to the system roots for `syslog+tls` and `https`, as the definition-fetch CA bundle does. Certificates are always verified; there is no switch to turn verification off.
- **Outbox:** migration `packages/server/migrations/audit-log/0011_audit-forward-queue.sql`:
  `create table audit_forward_queue (event_id text primary key references audit_events(id) on delete cascade, queued_at timestamptz not null default now());`
  The audit hook inserts `event_id` in the caller's transaction **only when forwarding is configured**. Retention deletes events, and the cascade deletes their queue rows.
- **Forwarder:**
  - **Claiming:** it claims up to 100 queue rows joined to their events, ordered by the event's `(at, id)`, with `for update skip locked`. The transaction stays open only for the send. It deletes the claimed rows and commits after the sink accepts; it rolls back on failure.
  - **Polling:** every 2 s while the last pass found work, every 5 s when idle.
  - **Backoff:** on a send failure it backs off 5 s, doubling to 300 s, and resets after a success.
  - **Logging:** one `warn` when forwarding starts failing and one `info` when it recovers, never one line per failure. No log line carries the token or an event body.
  - **License:** before each pass it reads `license.state()`. Without `audit-log` among the features it sends nothing and checks again after 60 s, with one `info` on pausing and one on resuming.
  - **Shutdown:** it stops from an `onClose` hook, finishing a batch under way, as the sweeper does.
- **What is sent:** each event as the API returns it (`auditEventSchema`). Events never carry secrets (audit-log spec §6), so nothing is masked on the way out.
- **Syslog** (`syslog+tcp`, `syslog+tls`):
  - **Message:** one RFC 5424 message per event: `<110>1 <at> <hostname> wirebench-server - <action> - <event JSON>`. PRI 110 is facility 13 (log audit) with severity 6 (informational). The hostname is `os.hostname()`, or `-` when that is empty.
  - **Framing:** RFC 6587 octet counting, `<byte length> <message>`.
  - **Connection:** one persistent connection, reconnected after an error, with a 10 s connect timeout. A batch counts as accepted when every write has flushed without a socket error.
- **HTTPS:** `POST` to the URL with `content-type: application/json`, the body `{ "events": [ … ] }`, and the bearer token when one is set. Any 2xx accepts the batch. Anything else, a timeout (10 s) or a network error is a failure. No redirects are followed.
- **Delivery** is at least once: a crash after the sink accepts and before the commit resends the batch. Receivers de-duplicate on `id`.
- Never name which product inspired a feature (`pnpm check:banned-terms`).
- **Gate:** `WIREBENCH_SKIP_PERF=1 nice pnpm check` green before every commit, with `WIREBENCH_SERVER_TEST_DATABASE_URL=postgres://wirebench:wirebench@127.0.0.1:5432/wirebench_test`.
- **Commits:** one per task, subject ending `(#209)`. No `Co-Authored-By` or `Claude-Session` trailer. No local e2e.

## Rulings made while planning

1. **A transactional outbox,** not an in-memory queue and not a cursor over `audit_events`. A cursor on `(at, id)` misses events whose transactions commit out of order, and memory loses events on a restart. The outbox costs one insert per event, and only when forwarding is on.
2. **One destination per server.** A second sink or a fan-out can come later if anyone asks.
3. **No UDP:** it loses events without a trace, which an audit trail must not.
4. **While unlicensed, forwarding pauses and the queue keeps filling;** when a license comes back the backlog is sent. Retention still bounds the queue.
5. **The claim transaction is held only for one batch's send,** bounded by the 10 s timeouts, so a slow sink cannot hold locks long.
6. **No admin command or route for queue depth in this slice.** The guide gives the SQL (`select count(*) from audit_forward_queue`), and the log lines say when forwarding fails and recovers.

## Tasks

### Task 1: Config, the outbox and the forwarder loop

**Files:**
- Modify `packages/server/src/config.ts`: the three variables, validated as above, in both the schema and the documented list.
- Create `packages/server/migrations/audit-log/0011_audit-forward-queue.sql`.
- Modify `packages/server/src/audit-log/hook.ts`: `auditHook(now, { forward: boolean })` inserts the queue row.
- Modify `packages/server/src/audit-log/repo.ts`: `enqueueForward`; `claimForwardBatch(tx, limit)`, which returns the events in `(at, id)` order; `deleteForwarded(tx, ids)`.
- Create `packages/server/src/audit-log/forward/forwarder.ts`: `interface ForwardSink { send(events: AuditEvent[]): Promise<void>; close(): Promise<void> }` and `class AuditForwarder`. The forwarder takes deps `{ db, sink, license: () => LicenseService, now, setTimer, log }` and exposes `start()`, `stop()` and `runOnce()`.

Tests:
- **Config unit tests:** each scheme is accepted; `http` on a non-loopback host is refused; a token with a syslog URL is refused; an unknown scheme is refused; no error text carries the value.
- **Integration tests,** in `packages/server/test/integration/audit-log/forward-queue.test.ts` against Postgres with a fake sink:
  - Configured, a recorded event is queued in the same transaction.
  - A rolled-back action queues nothing.
  - Unconfigured, nothing is queued.
  - `runOnce` sends in order and empties the queue.
  - A failing sink keeps the rows and backs off 5 → 10 → … → 300 s.
  - Without the feature it sends nothing and the rows stay.
  - Deleting an event (retention) removes its queue row.
  - Two concurrent `runOnce` calls never send the same event twice (`skip locked`).
- **Migration-list test:** update it for `11_audit-forward-queue`.

- [ ] Write the tests first, then implement, gate and commit `feat(server): an outbox and forwarder for audit events (#209)`.

### Task 2: The syslog and HTTPS sinks

**Files:**
- Create `packages/server/src/audit-log/forward/syslog-sink.ts`: `syslogMessage(event, hostname)`, `frame(message)` and `class SyslogSink`, taking `{ host, port, tls?: { ca?: string }, connectTimeoutMs }`.
- Create `packages/server/src/audit-log/forward/https-sink.ts`: `class HttpsSink`, taking `{ url, token?, ca?, timeoutMs }`.
- Create `packages/server/src/audit-log/forward/sink.ts`: `sinkFromConfig(config)`, which reads the CA file once, at start.
- For a custom CA, follow how the existing definition-fetch CA bundle adds roots, whether that is undici or `node:https`.

Tests:
- **Unit tests:**
  - The exact RFC 5424 line and its octet-counted frame, for a fixed event and hostname.
  - Multi-byte UTF-8 is counted in bytes, not characters.
- **Against local servers:**
  - A `net` server receives framed messages in order.
  - A `tls` server with a test certificate is verified with the CA passed in, and receives the messages. Look for an existing test-certificate helper or fixture first.
  - An HTTP server on 127.0.0.1 receives the JSON body and the bearer header.
  - A 500, a redirect, a hang past the timeout and a closed port each make `send` reject.
  - A syslog server that drops the connection is reconnected on the next send.

- [ ] Write the tests first, then implement, gate and commit `feat(server): syslog over TCP or TLS, and HTTPS, as audit sinks (#209)`.

### Task 3: Wiring, end to end

**Files:**
- Modify `packages/server/src/audit-log/module.ts`. When `ctx.config.auditForwardUrl` is set:
  - build the sink;
  - pass `forward: true` to the hook;
  - start an `AuditForwarder` with `license: () => ctx.license`;
  - stop the forwarder and close the sink `onClose`, after the sweeper.

Tests:
- **Integration tests,** in `packages/server/test/integration/audit-log/forward-e2e.test.ts`, using `licensingHarness` on Enterprise, the forward URL pointed at a local HTTP sink, and an injected timer:
  - A real action, such as creating a team, reaches the sink with its event.
  - With the sink down the action still answers 2xx, and the event arrives once the sink is back.
  - On Community nothing is sent until an Enterprise license is installed; then the backlog arrives.
  - Shutting down mid-batch neither loses events nor duplicates them beyond at-least-once.

- [ ] Write the tests first, then implement, gate and commit `feat(server): forward audit events from a running server (#209)`.

### Task 4: Docs

**Files:**
- `docs-site/src/content/docs/guides/server-audit-log.mdx`: a *Forwarding* section covering:
  - the three variables;
  - the formats, with an example syslog line and an example HTTPS body;
  - at-least-once delivery and de-duplicating on `id`;
  - the pause without Enterprise;
  - how failures are logged;
  - the queue-depth SQL.
- The server configuration reference, wherever the docs list `WIREBENCH_SERVER_*` variables. Find it, and check whether it is generated from `config.ts`.
- `packages/server/README.md`: one paragraph in *Audit log*.
- `CHANGELOG.md`: extend the audit-log entry.
- `docs/specs/2026-10-01-wirebench-server-audit-log-design.md` §1.2: point "syslog or HTTP push" to this plan.

- [ ] Run `pnpm check:banned-terms` and the docs build, then gate and commit `docs: forwarding audit events to syslog or HTTPS (#209)`.

## After the last task

1. A final review of the #209 range, then one fix wave.
2. `pnpm test:perf`, then push `feat/audit-log`.
3. Open a PR that closes #209 and turn on Auto-fix.
4. Merge with `gh pr merge --merge` only when the owner asks.

## Open questions

None.
