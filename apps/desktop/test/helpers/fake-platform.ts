/** A `HostPlatform` and `Caller` for tests that must not touch Electron or the real user data. */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ALL_CAPABILITIES, type Caller, type HostPlatform } from '../../src/main/host/platform.js';
import { createNativeDialogs, type NativeDialogs } from '../../src/main/native-dialogs.js';

/** Each call gets its own empty `userData` directory under the OS temp directory. */
export function createFakePlatform(overrides: Partial<HostPlatform> & { userData?: string } = {}): HostPlatform {
  const { userData, ...rest } = overrides;
  const dir = userData ?? mkdtempSync(join(tmpdir(), 'wirebench-fake-'));
  return {
    paths: { userData: () => dir, temp: () => tmpdir(), logs: () => join(dir, 'logs') },
    secrets: {
      available: () => true,
      encrypt: (plain) => Buffer.from(`sealed:${plain}`, 'utf8'),
      decrypt: (sealed) => sealed.toString('utf8').replace(/^sealed:/, ''),
    },
    app: {
      version: () => '0.0.0-test',
      packaged: () => false,
      quit: () => undefined,
      osTheme: () => 'light',
      onOsThemeChanged: () => () => undefined,
    },
    proxy: { resolve: () => Promise.resolve('DIRECT') },
    capabilities: new Set(ALL_CAPABILITIES),
    ...rest,
  };
}

/** A caller that records what it was sent; `close()` ends it and `reset()` makes it start over, as a reloaded renderer does. */
export function fakeCaller(id = 1): Caller & { sent: Array<[string, unknown]>; close(): void; reset(): void } {
  const sent: Array<[string, unknown]> = [];
  const listeners = new Set<() => void>();
  const resetListeners = new Set<() => void>(); // of both kinds: `reset()` fires them all
  let closed = false;
  return {
    id,
    sent,
    send(channel, payload) {
      if (!closed) sent.push([channel, payload]);
    },
    isClosed: () => closed,
    onReset(listener) {
      resetListeners.add(listener);
      return () => {
        resetListeners.delete(listener);
      };
    },
    reset() {
      if (closed) return;
      for (const listener of [...resetListeners]) listener();
    },
    onClosed(listener) {
      if (closed) {
        let cancelled = false;
        queueMicrotask(() => {
          if (!cancelled) listener();
        });
        return () => {
          cancelled = true;
        };
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    close() {
      if (closed) return;
      closed = true;
      const pending = [...listeners];
      listeners.clear();
      for (const listener of pending) {
        try {
          listener();
        } catch {
          // One listener's failure must not keep the others from hearing the caller closed.
        }
      }
    },
  };
}

/** The native pickers over a fake platform; give it `dialogs` to answer them, or leave them for a test that never opens one. */
export function fakeNativeDialogs(overrides: Partial<HostPlatform> = {}): NativeDialogs {
  return createNativeDialogs(createFakePlatform(overrides));
}
