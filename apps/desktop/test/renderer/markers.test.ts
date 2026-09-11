import { afterEach, describe, expect, it, vi } from 'vitest';
import { setMarkerApi } from '../../src/renderer/editor/markers.js';
import type { MarkerApi } from '../../src/renderer/editor/markers.js';

type GlobalWithHandle = typeof globalThis & {
  __wirebenchMonaco?: MarkerApi | undefined;
  wirebench?: { env?: { e2e?: boolean } };
};

const fakeMonaco = { editor: { setModelMarkers: vi.fn() } } as unknown as MarkerApi;

describe('setMarkerApi — the __wirebenchMonaco e2e handle', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    delete (globalThis as GlobalWithHandle).__wirebenchMonaco;
    delete (globalThis as GlobalWithHandle).wirebench;
  });

  it('exposes the handle in a dev build regardless of the e2e flag', () => {
    vi.stubEnv('DEV', true);
    setMarkerApi(fakeMonaco);
    expect((globalThis as GlobalWithHandle).__wirebenchMonaco).toBe(fakeMonaco);
  });

  it('exposes the handle in a non-dev build when window.wirebench.env.e2e is set', () => {
    vi.stubEnv('DEV', false);
    (globalThis as GlobalWithHandle).wirebench = { env: { e2e: true } };
    setMarkerApi(fakeMonaco);
    expect((globalThis as GlobalWithHandle).__wirebenchMonaco).toBe(fakeMonaco);
  });

  it('never exposes the handle in a non-dev, non-e2e build — a real user’s', () => {
    vi.stubEnv('DEV', false);
    (globalThis as GlobalWithHandle).wirebench = { env: { e2e: false } };
    setMarkerApi(fakeMonaco);
    expect((globalThis as GlobalWithHandle).__wirebenchMonaco).toBeUndefined();
  });

  it('never exposes the handle in a non-dev build with no wirebench API at all', () => {
    vi.stubEnv('DEV', false);
    setMarkerApi(fakeMonaco);
    expect((globalThis as GlobalWithHandle).__wirebenchMonaco).toBeUndefined();
  });
});
