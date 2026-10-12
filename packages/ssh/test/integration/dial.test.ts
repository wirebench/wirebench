import { afterEach, describe, expect, it } from 'vitest';
import type { Client } from 'ssh2';
import { dialChain } from '../../src/index.js';
import type { DialledChain } from '../../src/index.js';
import { startSshFixture } from '../helpers/ssh-fixture.js';
import type { SshFixture } from '../helpers/ssh-fixture.js';

const accept = () => Promise.resolve('accept' as const);
const hop = (port: number, password: string) => ({
  address: '127.0.0.1',
  port,
  user: 'tester',
  auth: { kind: 'password' as const, password },
  keepAlive: 0,
  connectTimeout: 5,
});
const open: SshFixture[] = [];
let chain: DialledChain | undefined;
afterEach(async () => {
  chain?.endAll();
  chain = undefined;
  await Promise.all(open.splice(0).map((f) => f.close()));
});
async function fixture(password: string, allowForwardOut = false) {
  const f = await startSshFixture({ password: { user: 'tester', password }, allowForwardOut });
  open.push(f);
  return f;
}
/** The fixture runs nothing on exec and exits 0, so an exit status of 0 proves the client is usable. */
function canExec(client: Client): Promise<boolean> {
  return new Promise((resolve) => {
    client.exec('true', (error, channel) => {
      if (error) return resolve(false);
      channel.on('exit', (code: number | null) => resolve(code === 0));
      channel.on('close', () => resolve(false));
      channel.resume();
    });
  });
}

describe('dialChain', () => {
  it('one hop resolves with a client that can exec', async () => {
    const f = await fixture('pw');
    chain = await dialChain({ hops: [hop(f.port, 'pw')], verifyHostKey: accept });
    expect(await canExec(chain.client)).toBe(true);
    expect(chain.lost).toBe(false);
  });
  it('two hops resolve with the client on the target', async () => {
    const inner = await fixture('in');
    const outer = await fixture('out', true);
    chain = await dialChain({ hops: [hop(outer.port, 'out'), hop(inner.port, 'in')], verifyHostKey: accept });
    expect(await canExec(chain.client)).toBe(true);
  });
  it('a refused key rejects with ssh-host-key-new', async () => {
    const f = await fixture('pw');
    await expect(
      dialChain({ hops: [hop(f.port, 'pw')], verifyHostKey: () => Promise.resolve('reject' as const) }),
    ).rejects.toMatchObject({ code: 'ssh-host-key-new', details: { host: `127.0.0.1:${f.port}` } });
  });
  it('a wrong password rejects with ssh-auth-failed', async () => {
    const f = await fixture('pw');
    await expect(dialChain({ hops: [hop(f.port, 'nope')], verifyHostKey: accept })).rejects.toMatchObject({
      code: 'ssh-auth-failed',
      details: { method: 'password' },
    });
  });
  it('endAll() twice does not throw', async () => {
    const f = await fixture('pw');
    chain = await dialChain({ hops: [hop(f.port, 'pw')], verifyHostKey: accept });
    expect(() => {
      chain!.endAll();
      chain!.endAll();
    }).not.toThrow();
  });
  it('stopping the jump fixture fires onLost once and sets lost', async () => {
    const inner = await fixture('in');
    const outer = await fixture('out', true);
    chain = await dialChain({ hops: [hop(outer.port, 'out'), hop(inner.port, 'in')], verifyHostKey: accept });
    let fired = 0;
    const lost = new Promise<void>((resolve) =>
      chain!.onLost(() => {
        fired += 1;
        resolve();
      }),
    );
    await outer.close();
    await lost;
    await new Promise((r) => setTimeout(r, 100));
    expect(fired).toBe(1);
    expect(chain.lost).toBe(true);
  });
  it('endAll() alone leaves lost false', async () => {
    const f = await fixture('pw');
    chain = await dialChain({ hops: [hop(f.port, 'pw')], verifyHostKey: accept });
    let fired = 0;
    chain.onLost(() => {
      fired += 1;
    });
    chain.endAll();
    await new Promise((r) => setTimeout(r, 200));
    expect(chain.lost).toBe(false);
    expect(fired).toBe(0);
  });
});
