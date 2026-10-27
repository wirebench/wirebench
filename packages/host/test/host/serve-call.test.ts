// @vitest-environment node
/**
 * `serveCall` is how an embedder other than the desktop serves a host (hosted edition spec §17.3): one
 * frame in, one reply out, run as a call from the caller, with a channel the host lacks, or one the
 * embedder's allowlist refuses, answered `host-capability-missing` before anything runs.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createHost, type Host } from '../../src/host/create-host.js';
import { serveCall } from '../../src/host/serve-call.js';
import { createFakePlatform, fakeCaller } from '../helpers/fake-platform.js';

const hosts: Host[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.shutdown();
});

async function started(): Promise<Host> {
  const host = await createHost(createFakePlatform());
  hosts.push(host);
  return host;
}

describe('serveCall', () => {
  it("answers with the frame's id and the handler's envelope", async () => {
    const host = await started();
    const caller = fakeCaller(1);
    host.attach(caller);
    await expect(
      serveCall(host, caller, { id: 41, channel: 'workspace.snapshot', request: undefined }),
    ).resolves.toEqual({ id: 41, ok: true, value: { workspace: null } });
  });

  it("runs the handler as a call from the caller, so it reaches that caller's scope", async () => {
    const host = await started();
    const first = fakeCaller(1);
    const second = fakeCaller(2);
    host.attach(first);
    host.attach(second);
    // With two scopes, a call from no caller has no window to route to; one from `second` has its own.
    const run = host.handlers.get('workspace.snapshot');
    await expect(run?.(undefined, second)).resolves.toMatchObject({ ok: false, error: { code: 'no-window' } });
    await expect(
      serveCall(host, second, { id: 1, channel: 'workspace.snapshot', request: undefined }),
    ).resolves.toEqual({ id: 1, ok: true, value: { workspace: null } });
  });

  it("answers a channel the host does not have with host-capability-missing, naming the channel's group", async () => {
    const host = await started();
    await expect(serveCall(host, fakeCaller(1), { id: 7, channel: 'nothing.here', request: {} })).resolves.toEqual({
      id: 7,
      ok: false,
      error: {
        code: 'host-capability-missing',
        message: 'This host does not serve nothing calls',
        details: { capability: 'nothing' },
      },
    });
  });

  it('answers a channel the allowlist refuses the same way, and does not run it', async () => {
    const host = await started();
    const caller = fakeCaller(1);
    host.attach(caller);
    const asked: string[] = [];
    const allowed = (channel: string): boolean => {
      asked.push(channel);
      return channel.startsWith('preferences.get');
    };
    const refused = await serveCall(
      host,
      caller,
      { id: 2, channel: 'preferences.update', request: { patch: { ui: { historyCap: 77 } } } },
      allowed,
    );
    expect(refused).toMatchObject({
      id: 2,
      ok: false,
      error: { code: 'host-capability-missing', details: { capability: 'preferences' } },
    });
    expect(asked).toEqual(['preferences.update']);
    // The refused update never ran: the preference is still the default.
    const read = (await serveCall(
      host,
      caller,
      { id: 3, channel: 'preferences.get', request: undefined },
      allowed,
    )) as {
      readonly ok: boolean;
      readonly value: { readonly preferences: { readonly ui: { readonly historyCap: number } } };
    };
    expect(read.ok).toBe(true);
    expect(read.value.preferences.ui.historyCap).not.toBe(77);
  });

  it("passes an invalid request to the handler's envelope, which refuses it", async () => {
    const host = await started();
    await expect(
      serveCall(host, fakeCaller(1), { id: 5, channel: 'preferences.update', request: { patch: 'not an object' } }),
    ).resolves.toMatchObject({ id: 5, ok: false, error: { code: 'ipc-invalid-request' } });
  });
});
