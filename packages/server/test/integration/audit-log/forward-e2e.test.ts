/**
 * Audit forwarding from a running server (issue #209): the audit-log module with a forward URL pointed
 * at a local HTTP receiver, real actions through the routes, and the forwarder's timer fired by hand.
 */
import { writeFile } from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { AuditEvent } from '@wirebench/engine';
import { afterEach, expect, it, vi } from 'vitest';
import {
  backoff,
  FORWARD_BUSY_MS,
  FORWARD_IDLE_MS,
  FORWARD_UNLICENSED_MS,
} from '../../../src/audit-log/forward/forwarder.js';
import { auditLogModule } from '../../../src/audit-log/module.js';
import { ConfigError } from '../../../src/config.js';
import { describeDb, testDatabase } from '../../helpers/database.js';
import { mkTempDir, removeTempDir } from '../../helpers/git.js';
import { httpReceiver, type HttpReceiver } from '../../helpers/forward-receivers.js';
import { signedInUser, type IdentityHarness, type SignedInUser } from '../../helpers/identity.js';
import { license, licensingHarness, testKeys } from '../../helpers/licensing.js';
import { freePort } from '../../helpers/net.js';
import { call } from '../../helpers/teams.js';
import { manualTimers, type ManualTimers } from '../../helpers/timers.js';

/** Every delay the forwarder arms; the sweeper's ten minutes is not among them. */
const FORWARD_DELAYS = [
  ...new Set([FORWARD_BUSY_MS, FORWARD_IDLE_MS, FORWARD_UNLICENSED_MS, ...[1, 2, 3, 4, 5, 6, 7].map(backoff)]),
];
const WAIT = { timeout: 5_000, interval: 20 };
/** Each test starts its own server over a fresh schema (two, for the restart). */
const TEST_TIMEOUT_MS = 30_000;
/** How long a close that should be waiting on a held batch is watched for finishing early. */
const CLOSE_PROBE_MS = 300;

/** The forwarder's armed delay, once its pass under way has finished. */
async function settled(timers: ManualTimers): Promise<number> {
  let armed: number | undefined;
  await vi.waitFor(() => {
    armed = FORWARD_DELAYS.find((ms) => timers.pending(ms) > 0);
    expect(armed).toBeDefined();
  }, WAIT);
  return armed!;
}

/** Fires the forwarder's timer and waits for that pass; returns the delay it armed next. */
async function pass(timers: ManualTimers): Promise<number> {
  timers.fire(await settled(timers));
  return settled(timers);
}

const received = (receiver: HttpReceiver): AuditEvent[] =>
  receiver.requests.flatMap((request) => (JSON.parse(request.body) as { events: AuditEvent[] }).events);

describeDb('audit forwarding from a running server (issue #209)', () => {
  const keys = testKeys();
  const cleanup: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const step of cleanup.splice(0).reverse()) await step();
  });

  async function server(url: string, db?: IdentityHarness['db']) {
    const timers = manualTimers();
    const h = await licensingHarness(keys, {
      env: { WIREBENCH_SERVER_AUDIT_FORWARD_URL: url },
      ...(db !== undefined ? { db } : {}),
      extra: (clock) => [auditLogModule({ now: () => clock.now, setTimer: timers.setTimer })],
    });
    let closed = false;
    const close = async () => {
      if (closed) return;
      closed = true;
      await h.close();
    };
    cleanup.push(close);
    return { h, timers, close };
  }
  async function receiver(port?: number, answer?: Parameters<typeof httpReceiver>[0]) {
    const r = await httpReceiver(answer, undefined, port);
    cleanup.push(() => r.close());
    return r;
  }
  const enterprise = async (h: IdentityHarness, admin: SignedInUser) => {
    const res = await call(h, admin, 'PUT', '/license', { license: license(keys, { edition: 'enterprise' }) });
    expect(res.status).toBe(200);
  };
  const createTeam = async (h: IdentityHarness, admin: SignedInUser, name: string) => {
    const res = await call<{ id: string }>(h, admin, 'POST', '/teams', { name });
    expect(res.status).toBe(201);
    const row = await h.db.query<{ id: string }>(
      `select id from audit_events where action = 'team.created' and target_id = $1`,
      [res.body.id],
    );
    return { teamId: res.body.id, eventId: row.rows[0]!.id };
  };
  const queued = async (h: IdentityHarness | { db: IdentityHarness['db'] }, eventId?: string) =>
    (
      await h.db.query<{ event_id: string }>(
        eventId === undefined
          ? 'select event_id from audit_forward_queue'
          : 'select event_id from audit_forward_queue where event_id = $1',
        eventId === undefined ? [] : [eventId],
      )
    ).rows.length;

  it(
    'a real action reaches the sink with its event',
    async () => {
      const r = await receiver();
      const { h, timers } = await server(`http://127.0.0.1:${String(r.port)}/audit`);
      const admin = await signedInUser(h, { email: 'root@example.com', serverAdmin: true });
      // The first pass ran at start, on Community.
      expect(await settled(timers)).toBe(FORWARD_UNLICENSED_MS);
      await enterprise(h, admin);
      const { teamId, eventId } = await createTeam(h, admin, 'Payments');
      expect(await pass(timers)).toBe(FORWARD_BUSY_MS);
      const event = received(r).find((e) => e.id === eventId);
      expect(event).toMatchObject({
        action: 'team.created',
        target: { kind: 'team', id: teamId },
        teamId,
        actor: { kind: 'user', userId: admin.user.id },
        details: { name: 'Payments' },
      });
      expect(r.requests[0]).toMatchObject({ method: 'POST', url: '/audit' });
      expect(await queued(h)).toBe(0);
      expect(await pass(timers)).toBe(FORWARD_IDLE_MS);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'with the sink down the action still answers 2xx, and the event arrives once the sink is back',
    async () => {
      const port = await freePort();
      const { h, timers } = await server(`http://127.0.0.1:${String(port)}/audit`);
      const admin = await signedInUser(h, { email: 'root@example.com', serverAdmin: true });
      await settled(timers);
      await enterprise(h, admin);
      const { eventId } = await createTeam(h, admin, 'Down');
      // backoff(1) equals the idle delay, so the first pass alone cannot tell a failure from an empty
      // queue: the event still being queued, and the second delay doubling to backoff(2), can.
      expect(await pass(timers)).toBe(backoff(1));
      expect(await queued(h, eventId)).toBe(1);
      expect(backoff(2)).not.toBe(FORWARD_IDLE_MS);
      expect(await pass(timers)).toBe(backoff(2));
      expect(await queued(h, eventId)).toBe(1);
      const r = await receiver(port);
      expect(await pass(timers)).toBe(FORWARD_BUSY_MS);
      expect(received(r).map((e) => e.id)).toContain(eventId);
      expect(await queued(h)).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'on Community nothing is sent until an Enterprise license is installed; then the backlog arrives',
    async () => {
      const r = await receiver();
      const { h, timers } = await server(`http://127.0.0.1:${String(r.port)}/audit`);
      const admin = await signedInUser(h, { email: 'root@example.com', serverAdmin: true });
      await settled(timers);
      const first = await createTeam(h, admin, 'One');
      const second = await createTeam(h, admin, 'Two');
      expect(await pass(timers)).toBe(FORWARD_UNLICENSED_MS);
      expect(await pass(timers)).toBe(FORWARD_UNLICENSED_MS);
      expect(r.requests).toHaveLength(0);
      expect(await queued(h, first.eventId)).toBe(1);
      expect(await queued(h, second.eventId)).toBe(1);
      await enterprise(h, admin);
      expect(await pass(timers)).toBe(FORWARD_BUSY_MS);
      const ids = received(r).map((e) => e.id);
      expect(ids).toEqual(expect.arrayContaining([first.eventId, second.eventId]));
      // Oldest first, as the queue is drained.
      expect(ids.indexOf(first.eventId)).toBeLessThan(ids.indexOf(second.eventId));
      expect(await queued(h)).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'shutting down mid-batch waits for the batch, which commits, before the server closes',
    async () => {
      const db = await testDatabase();
      cleanup.push(() => db.close());
      // Records each batch and holds its response until the test answers it.
      const pending: ServerResponse[] = [];
      const held = await httpReceiver((res) => pending.push(res));
      const first = await server(`http://127.0.0.1:${String(held.port)}/audit`, db);
      // Registered after the server, so on a failure it closes first and no held request outlives the test.
      cleanup.push(() => held.close());
      const admin = await signedInUser(first.h, { email: 'root@example.com', serverAdmin: true });
      await settled(first.timers);
      await enterprise(first.h, admin);
      const { eventId } = await createTeam(first.h, admin, 'Shutdown');
      first.timers.fire(await settled(first.timers));
      await vi.waitFor(() => {
        expect(received(held).map((e) => e.id)).toContain(eventId);
      }, WAIT);
      let closed = false;
      const closing = first.close().then(() => {
        closed = true;
      });
      // The close waits on the forwarder's batch; without that it would finish at once.
      await delay(CLOSE_PROBE_MS);
      expect(closed).toBe(false);
      for (const res of pending.splice(0)) res.writeHead(204).end();
      await closing;
      // Acknowledged before the close finished, so the batch committed.
      expect(await queued({ db }, eventId)).toBe(0);
      expect(await queued({ db })).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'a batch the sink drops at shutdown stays queued, and arrives after a restart (at least once)',
    async () => {
      const db = await testDatabase();
      cleanup.push(() => db.close());
      // Records each batch and never answers.
      const held = await httpReceiver(() => undefined);
      const first = await server(`http://127.0.0.1:${String(held.port)}/audit`, db);
      cleanup.push(() => held.close());
      const admin = await signedInUser(first.h, { email: 'root@example.com', serverAdmin: true });
      await settled(first.timers);
      await enterprise(first.h, admin);
      const { eventId } = await createTeam(first.h, admin, 'Dropped');
      first.timers.fire(await settled(first.timers));
      await vi.waitFor(() => {
        expect(received(held).map((e) => e.id)).toContain(eventId);
      }, WAIT);
      // Shut down while the batch waits on the sink; then the sink drops the connection.
      const closing = first.close();
      await held.close();
      await closing;
      // Never acknowledged, so the batch rolled back: the event is still queued, not lost.
      expect(await queued({ db }, eventId)).toBe(1);

      const r = await receiver();
      const second = await server(`http://127.0.0.1:${String(r.port)}/audit`, db);
      // The license is stored, so the pass at start is licensed and sends the backlog.
      expect(await settled(second.timers)).toBe(FORWARD_BUSY_MS);
      expect(received(r).map((e) => e.id)).toContain(eventId);
      expect(await queued({ db })).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'a CA file that cannot be read or holds no certificate refuses the start, without quoting the file',
    async () => {
      const dir = await mkTempDir('wbs-forward-ca-');
      cleanup.push(() => removeTempDir(dir));
      const notCa = join(dir, 'not-a-ca.pem');
      await writeFile(notCa, 'CA-FILE-CONTENTS-MARKER\n');
      for (const [file, message] of [
        [join(dir, 'missing.pem'), 'could not be read'],
        [notCa, 'holds no PEM certificate'],
      ] as const) {
        const db = await testDatabase();
        cleanup.push(() => db.close());
        const start = licensingHarness(keys, {
          env: {
            WIREBENCH_SERVER_AUDIT_FORWARD_URL: 'https://127.0.0.1:1/audit',
            WIREBENCH_SERVER_AUDIT_FORWARD_CA_FILE: file,
          },
          db,
          extra: (clock) => [auditLogModule({ now: () => clock.now, setTimer: manualTimers().setTimer })],
        });
        const error: unknown = await start.then(
          () => undefined,
          (e: unknown) => e,
        );
        expect(error).toBeInstanceOf(ConfigError);
        const problems = (error as ConfigError).problems;
        expect(problems).toEqual([
          { variable: 'WIREBENCH_SERVER_AUDIT_FORWARD_CA_FILE', message: expect.stringContaining(message) as string },
        ]);
        expect(JSON.stringify(problems) + String(error)).not.toContain('CA-FILE-CONTENTS-MARKER');
        expect(JSON.stringify(problems) + String(error)).not.toContain(file);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
