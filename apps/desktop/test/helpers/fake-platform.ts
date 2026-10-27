/** A `HostPlatform` and `Caller` for tests that must not touch Electron or the real user data. */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OptionalPart } from '../../src/main/host/capability.js';
import { ALL_CAPABILITIES, type Caller, type HostPlatform } from '../../src/main/host/platform.js';
import { createNativeDialogs, type NativeDialogs } from '../../src/main/native-dialogs.js';

/**
 * Each call gets its own empty `userData` directory under the OS temp directory. Every optional part is
 * there, doing nothing (dialogs cancel, the shell and power never act), unless `without` names it.
 */
export function createFakePlatform(
  overrides: Partial<HostPlatform> & { userData?: string; without?: readonly OptionalPart[] } = {},
): HostPlatform {
  const { userData, without = [], ...rest } = overrides;
  const dir = userData ?? mkdtempSync(join(tmpdir(), 'wirebench-fake-'));
  const platform: HostPlatform = {
    paths: { userData: () => dir, temp: () => tmpdir(), logs: () => join(dir, 'logs') },
    secrets: {
      available: () => true,
      encrypt: (plain) => Buffer.from(`sealed:${plain}`, 'utf8'),
      decrypt: (sealed) => sealed.toString('utf8').replace(/^sealed:/, ''),
    },
    app: {
      version: () => '0.0.0-test',
      runtimeVersion: () => '0.0.0-test',
      packaged: () => false,
      quit: () => undefined,
      osTheme: () => 'light',
      onOsThemeChanged: () => () => undefined,
    },
    proxy: { resolve: () => Promise.resolve('DIRECT') },
    dialogs: {
      openFile: () => Promise.resolve({ canceled: true, filePaths: [] }),
      saveFile: () => Promise.resolve({ canceled: true }),
      message: (_owner, opts) => Promise.resolve({ response: opts.cancelId ?? 0, checkboxChecked: false }),
    },
    shell: {
      openExternal: () => Promise.resolve(),
      openPath: () => Promise.resolve(''),
      reveal: () => undefined,
      trash: () => Promise.resolve(),
    },
    power: { onResume: () => () => undefined, onLock: () => () => undefined, idleSeconds: () => 0 },
    capabilities: new Set(ALL_CAPABILITIES),
    ...rest,
  };
  if (without.length === 0) return platform;
  // Rebuilt rather than `delete`d: the platform's members are readonly.
  return Object.fromEntries(
    Object.entries(platform).filter(([key]) => !(without as readonly string[]).includes(key)),
  ) as unknown as HostPlatform;
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
