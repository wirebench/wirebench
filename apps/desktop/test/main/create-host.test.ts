// @vitest-environment node
/**
 * `createHost` is the composition root as a function (host seam Task 5): one call builds every service
 * and fills one table with every channel the platform allows, with no process-wide side effect, so a
 * second host in the same process neither fails nor shares the first one's data (Review Focus 4).
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import pinned from '../fixtures/ipc-names.json' with { type: 'json' };
import { createHost, type Host } from '../../src/main/host/create-host.js';
import type { Caller, HostPlatform } from '../../src/main/host/platform.js';
import { PREFERENCES_FILE } from '../../src/main/preferences.js';
import { runAsCaller } from '../../src/main/window-scope.js';
import { createFakePlatform, fakeCaller } from '../helpers/fake-platform.js';

const hosts: Host[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.shutdown();
  vi.useRealTimers();
});

async function started(platform: HostPlatform = createFakePlatform()): Promise<Host> {
  const host = await createHost(platform);
  hosts.push(host);
  return host;
}

/** Runs `channel` on `host` the way `bindIpc` does: as a call from `caller`. */
async function invoke(host: Host, channel: string, raw: unknown, caller: Caller): Promise<unknown> {
  const run = host.handlers.get(channel);
  if (run === undefined) throw new Error(`no handler for ${channel}`);
  return await runAsCaller(caller.id, () => run(raw, caller));
}

describe('createHost', () => {
  it('builds two hosts in one process, each with every channel', async () => {
    const first = await started();
    const second = await started();
    expect([...first.handlers.keys()].sort()).toEqual(pinned.channels);
    expect([...second.handlers.keys()].sort()).toEqual(pinned.channels);
    expect(first.handlers).not.toBe(second.handlers);
  });

  it("reads each host's preferences from its own userData", async () => {
    const strict = createFakePlatform();
    writeFileSync(join(strict.paths.userData(), PREFERENCES_FILE), 'version: 1\nssl:\n  minVersion: TLSv1.3\n', 'utf8');
    const first = await started(strict);
    const second = await started();
    const caller = fakeCaller(1);
    await expect(invoke(first, 'preferences.get', undefined, caller)).resolves.toMatchObject({
      ok: true,
      value: { preferences: { ssl: { minVersion: 'TLSv1.3' } } },
    });
    await expect(invoke(second, 'preferences.get', undefined, caller)).resolves.toMatchObject({
      ok: true,
      value: { preferences: { ssl: { minVersion: 'TLSv1.2' } } },
    });
  });

  it('leaves out the channels that only open native dialogs on a platform without them', async () => {
    const full = await started();
    const bare = await started(createFakePlatform({ without: ['dialogs'] }));
    const missing = [...full.handlers.keys()].filter((name) => !bare.handlers.has(name)).sort();
    expect(missing).toEqual([
      'dialogs.openFile',
      'dialogs.openFolder',
      'dialogs.saveFile',
      'fs.openText',
      'fs.saveText',
    ]);
    expect([...bare.handlers.keys()].filter((name) => !full.handlers.has(name))).toEqual([]);
  });

  it('gives an attached caller its own workspace scope until it is detached', async () => {
    const host = await started();
    const caller = fakeCaller(7);
    await expect(invoke(host, 'workspace.snapshot', undefined, caller)).resolves.toMatchObject({
      ok: false,
      error: { code: 'no-window' },
    });
    host.attach(caller);
    await expect(invoke(host, 'workspace.snapshot', undefined, caller)).resolves.toEqual({
      ok: true,
      value: { workspace: null },
    });
    await host.detach(caller.id);
    await expect(invoke(host, 'workspace.snapshot', undefined, caller)).resolves.toMatchObject({
      ok: false,
      error: { code: 'no-window' },
    });
  });

  it('drops a scope when its caller closes', async () => {
    const host = await started();
    const caller = fakeCaller(8);
    host.attach(caller);
    caller.close();
    await expect(invoke(host, 'workspace.snapshot', undefined, caller)).resolves.toMatchObject({
      ok: false,
      error: { code: 'no-window' },
    });
  });

  it('releases its close listener on the caller when the caller is detached', async () => {
    const host = await started();
    const base = fakeCaller(9);
    const released = vi.fn();
    const caller: typeof base = {
      ...base,
      onClosed(listener) {
        const off = base.onClosed(listener);
        return () => {
          released();
          off();
        };
      },
    };
    host.attach(caller);
    expect(released).not.toHaveBeenCalled();
    await host.detach(caller.id);
    expect(released).toHaveBeenCalledTimes(1);
    base.close();
    await expect(invoke(host, 'workspace.snapshot', undefined, caller)).resolves.toMatchObject({
      ok: false,
      error: { code: 'no-window' },
    });
  });

  it('broadcasts to its own callers only', async () => {
    const first = await started();
    const second = await started();
    const mine = fakeCaller(1);
    const theirs = fakeCaller(2);
    first.attach(mine);
    second.attach(theirs);
    await invoke(first, 'preferences.update', { patch: { ui: { historyCap: 4321 } } }, mine);
    const caps = (caller: typeof mine): unknown[] =>
      caller.sent
        .filter(([channel]) => channel === 'preferences.changed')
        .map(([, payload]) => (payload as { preferences: { ui: { historyCap: number } } }).preferences.ui.historyCap);
    expect(caps(mine)).toContain(4321);
    expect(caps(theirs)).not.toContain(4321);
  });

  it('shuts down with no timer left pending', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const host = await createHost(createFakePlatform());
    host.attach(fakeCaller(3));
    const done = host.shutdown();
    // An open window is given its quit-drafts wait (two seconds) to hand over its staged edits.
    await vi.advanceTimersByTimeAsync(2_000);
    await done;
    expect(vi.getTimerCount()).toBe(0);
  });
});
