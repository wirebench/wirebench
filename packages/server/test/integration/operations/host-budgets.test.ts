/**
 * Slice 5 Task 9 (hosted edition spec §20.7): the host socket charges its send channels to the user's tenant. With
 * six sends a minute (a burst of one), the second send is answered `tenant-send-budget` with its retry time, as the
 * tab shows any failed send; calls that send nothing, the paired agent's path among them, are never charged.
 */
import { afterEach, beforeEach, expect, it } from 'vitest';
import { describeDb } from '../../helpers/database.js';
import { browserUser, hostHarness, openHost, type HostHarness } from '../../helpers/host.js';

describeDb('the host socket’s send budgets (§20.7)', () => {
  let h: HostHarness;
  beforeEach(async () => {
    h = await hostHarness({ env: { WIREBENCH_SERVER_TENANT_SENDS_PER_MINUTE: '6' } });
  });
  afterEach(() => h.close());

  it('refuses a send past the tenant’s budget, and charges nothing else', async () => {
    const alice = await browserUser(h, 'alice@example.com');
    const client = await openHost(h, alice);
    await client.waitFor((frame) => frame.type === 'hello');
    for (let n = 0; n < 3; n++) expect(await client.call('app.version')).toMatchObject({ ok: true });
    // The agent's path on the server host: the record of what an agent sent, which this host never sent.
    const recorded = await client.call('exchanges.recordAgentSend', {});
    expect(JSON.stringify(recorded)).not.toContain('tenant-send');

    // No workspace is open, so the host answers the first send with its own error; it was charged all the same.
    const first = await client.call('request.sendRest', { sendId: 's1', requestId: 'none' });
    expect(first).toMatchObject({ ok: false });
    expect(JSON.stringify(first)).not.toContain('tenant-send');
    expect(await client.call('request.sendRest', { sendId: 's2', requestId: 'none' })).toMatchObject({
      ok: false,
      error: { code: 'tenant-send-budget', details: { retryAfterMs: expect.any(Number) as number } },
    });
    // Another user of the tenant spends the same budget.
    const bob = await browserUser(h, 'bob@example.com');
    const other = await openHost(h, bob);
    await other.waitFor((frame) => frame.type === 'hello');
    expect(await other.call('request.send', { sendId: 'b1', requestId: 'none' })).toMatchObject({
      ok: false,
      error: { code: 'tenant-send-budget' },
    });
    expect(await client.call('app.version')).toMatchObject({ ok: true });
  });
});
