/**
 * A server host's secrets (hosted edition spec §17.4, §19.7, plan Task 23): sealed under the user key derived from
 * the tenant's data key, never straight from the root; and their audit rows, written after the call answers, are
 * kept until they commit, so the module's shutdown waits for them.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { open } from '../../../src/hooks/secret-box.js';
import { hostDirectories, userSecretsKey } from '../../../src/host/server-platform.js';
import type { PendingWrites } from '../../../src/pending-writes.js';
import { describeDb } from '../../helpers/database.js';
import { browserUser, hostHarness, openHost, type HostHarness } from '../../helpers/host.js';

const tick = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));

describeDb('a server host’s secrets', () => {
  let h: HostHarness;
  let writes: PendingWrites | undefined;
  let closed = false;
  /** Releases a block a failed test left held, so the harness can close. */
  let unblock: () => void = () => undefined;
  beforeEach(async () => {
    closed = false;
    unblock = () => undefined;
    writes = undefined;
    h = await hostHarness({
      onSecretWrites: (made) => {
        writes = made;
      },
    });
  });
  afterEach(async () => {
    unblock();
    if (!closed) await h.close();
  });

  /** Holds every `secret.*` audit hook until `release`. */
  function blockSecretAudit(): { release(): void; readonly reached: Promise<void> } {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reached: () => void = () => undefined;
    const isReached = new Promise<void>((resolve) => {
      reached = resolve;
    });
    unblock = () => {
      release();
    };
    h.hooks.audit.push(async (_tx, event) => {
      if (!event.action.startsWith('secret.')) return;
      reached();
      await held;
    });
    return { release, reached: isReached };
  }

  it("seals under the tenant's data key, not under the root", async () => {
    const alice = await browserUser(h, 'alice@example.com');
    const client = await openHost(h, alice);
    await client.waitFor((frame) => frame.type === 'hello');
    expect(await client.call('secrets.set', { value: 'gamma-secret-0123456789', label: 'k' })).toMatchObject({
      ok: true,
    });
    const file = JSON.parse(
      await readFile(join(hostDirectories(h.dataDir, h.tdb.scope, alice.user.id).checkout, 'secrets.json'), 'utf8'),
    ) as { entries: Record<string, { value: string; encrypted: boolean }> };
    const [entry] = Object.values(file.entries);
    expect(entry?.encrypted).toBe(true);
    const sealed = Buffer.from(entry!.value, 'base64');
    const dataKey = await h.ctx.tenancy.dataKey(h.tdb.scope);
    expect(open(userSecretsKey(dataKey, alice.user.id), sealed)).toBe('gamma-secret-0123456789');
    expect(() => open(userSecretsKey(h.ctx.config.secretsKey!, alice.user.id), sealed)).toThrow();
  });

  it('settled() waits for the secret.written row the call answered before', async () => {
    const block = blockSecretAudit();
    const alice = await browserUser(h, 'alice@example.com');
    const client = await openHost(h, alice);
    await client.waitFor((frame) => frame.type === 'hello');
    expect(await client.call('secrets.set', { value: 'delta-secret-0123456789', label: 'held' })).toMatchObject({
      ok: true,
    });
    await block.reached;
    let done = false;
    const settling = writes!.settled().then(() => {
      done = true;
    });
    await tick();
    expect(done).toBe(false);
    block.release();
    await settling;
    expect(h.audit.filter((event) => event.action === 'secret.written')).toHaveLength(1);
  });

  it('shutdown waits for a secret audit row still being written', async () => {
    const block = blockSecretAudit();
    const alice = await browserUser(h, 'alice@example.com');
    const client = await openHost(h, alice);
    await client.waitFor((frame) => frame.type === 'hello');
    expect(await client.call('secrets.set', { value: 'eps-secret-0123456789', label: 'at close' })).toMatchObject({
      ok: true,
    });
    await block.reached;
    let closedApp = false;
    const closing = h.app.close().then(() => {
      closedApp = true;
    });
    await tick(150);
    expect(closedApp).toBe(false);
    block.release();
    await closing;
    await vi.waitFor(() => {
      expect(h.audit.filter((event) => event.action === 'secret.written')).toHaveLength(1);
    });
    closed = true;
    await h.close();
  });
});
