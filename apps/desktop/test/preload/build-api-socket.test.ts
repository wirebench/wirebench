// @vitest-environment node
/**
 * The renderer's API builder works over a socket-shaped transport (ADR-0033): `buildApi` is handed an
 * `invoke` that routes to a host's handler table and an `on` fed by what the host sends its caller, with
 * no Electron and no network in between.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createHost, type Host } from '../../src/main/host/create-host.js';
import { buildApi } from '../../src/preload/build-api.js';
import { runAsCaller } from '../../src/main/window-scope.js';
import { createFakePlatform, fakeCaller } from '../helpers/fake-platform.js';

let host: Host | undefined;

afterEach(async () => {
  await host?.shutdown();
  host = undefined;
});

describe('buildApi over an in-memory transport', () => {
  it('answers app.version and delivers an emitted event to its listener', async () => {
    const started = await createHost(createFakePlatform());
    host = started;
    const caller = fakeCaller(1);
    started.attach(caller);

    // The "socket": requests go to the table, and the caller's sends are the server-to-client frames.
    const listeners = new Map<string, Set<(payload: unknown) => void>>();
    const send = caller.send.bind(caller);
    caller.send = (channel, payload): void => {
      send(channel, payload);
      for (const listener of listeners.get(channel) ?? []) listener(payload);
    };
    const api = buildApi(
      async (name, request) => {
        const run = started.handlers.get(name);
        if (run === undefined) throw new Error(`no handler for ${name}`);
        return await runAsCaller(caller.id, () => run(request, caller));
      },
      (name, listener) => {
        const set = listeners.get(name) ?? new Set();
        set.add(listener);
        listeners.set(name, set);
        return () => {
          set.delete(listener);
        };
      },
    );

    await expect(api.app.version(undefined as never)).resolves.toMatchObject({
      ok: true,
      value: { electron: '0.0.0-test', version: expect.stringMatching(/^\d+\.\d+/) as unknown },
    });

    const seen: unknown[] = [];
    const off = api.on('preferences.changed', (payload) => seen.push(payload));
    await api.preferences.update({ patch: { ui: { historyCap: 4321 } } });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ preferences: { ui: { historyCap: 4321 } } });
    off();
    await started.detach(caller.id);
  });
});
