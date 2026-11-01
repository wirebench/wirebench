/**
 * The host's in-process live bridge delivers outside any tenant unit (tenancy Task 8 review M5; Task 11 review M1).
 * A frame sent while a unit is open must not run the other side's handler inside that unit: a handler that queried
 * there, without being awaited, would join the unit and roll it back with `tenancy-unawaited`.
 */
import { describe, expect, it } from 'vitest';
import type { Database, Querier } from '../../../src/db/querier.js';
import { liveBridge } from '../../../src/host/live-bridge.js';
import type { LiveConnection } from '../../../src/live/socket.js';
import { scopeOf } from '../../../src/tenancy/scope.js';
import { tenantDbFactory } from '../../../src/tenancy/tenant-db.js';

const A = scopeOf({ id: '00000000-0000-4000-8000-00000000000a', slug: 'a' });

/** A database whose `select 1` answers after 20 ms, as a real one takes a while. */
function slowDatabase(): Database {
  const querier: Querier = {
    query: (text: string) =>
      new Promise((resolve) => {
        setTimeout(() => resolve({ rows: [], rowCount: 0 }), text === 'select 1' ? 20 : 0);
      }),
  };
  const db: Database = { ...querier, transaction: (fn) => fn(querier), close: () => Promise.resolve() };
  return db;
}

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('liveBridge outside tenant units', () => {
  it('runs a handler a frame reaches while the sender holds a unit in no unit of its own', async () => {
    const tenancy = tenantDbFactory(slowDatabase());
    let server: LiveConnection | undefined;
    const bridge = liveBridge((connection) => {
      server = connection;
    });
    await tick(0);
    const handled: string[] = [];
    // The server side's handler queries and does not wait, as the live loop's auth lookup starts.
    server!.on('message', (data) => {
      handled.push(Buffer.isBuffer(data) ? data.toString('utf8') : '');
      void tenancy(A).query('select 1');
    });
    const client = bridge.socket as unknown as { send(data: string): void };
    // Both directions: a frame from the client end, and one from the server end, each sent inside a unit.
    const heard: string[] = [];
    (bridge.socket as unknown as EventTarget).addEventListener('message', (event) => {
      heard.push(String((event as MessageEvent).data));
      void tenancy(A).query('select 1');
    });
    await tenancy(A).transaction(async (tx) => {
      await tx.query('select 0');
      client.send('to the server');
      server!.send('to the client');
      // The deliveries run while the unit is still open.
      await tick(5);
    });
    expect(handled).toEqual(['to the server']);
    expect(heard).toEqual(['to the client']);
    await tick(30);
  });
});
