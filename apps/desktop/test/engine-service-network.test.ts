// @vitest-environment node
/**
 * Every WSDL read hands the engine the app's `network` (the CA bundle and proxy a send uses): the
 * Import dialog's import, the project import and its hydration re-fetch, the Update Definition
 * preview, and the legacy project import's network fallback.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const importWsdl = vi.fn();
vi.mock('@wirebench/engine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@wirebench/engine')>()),
  importWsdl: (...args: unknown[]) => importWsdl(...args) as unknown,
}));

const { EngineService } = await import('../src/main/engine-service.js');

const URL_SOURCE = { kind: 'url', url: 'http://wsdl.example.test/service.wsdl' } as const;

afterEach(() => {
  importWsdl.mockReset();
});

/** The `network` option the engine was given on its first call. */
function networkPassed(): unknown {
  return (importWsdl.mock.calls[0]?.[1] as { network?: unknown }).network;
}

describe('EngineService WSDL reads through the app network', () => {
  const network = vi.fn(() => Promise.resolve({}));

  it('passes it on the Import dialog import', async () => {
    importWsdl.mockRejectedValue(new Error('stop here'));
    const service = new EngineService(vi.fn(), network);

    await expect(service.importDefinition({ source: URL_SOURCE })).rejects.toThrow('stop here');

    expect(networkPassed()).toBe(network);
  });

  it('passes it on a project import and its hydration re-fetch', async () => {
    importWsdl.mockRejectedValue(new Error('stop here'));
    const service = new EngineService(vi.fn(), network);

    await expect(
      service.importForProject({
        interfaceId: 'i1',
        source: URL_SOURCE,
        cache: { dir: '/tmp/unused', mode: 'prefer-cache' },
        auth: { type: 'kerberos' },
      }),
    ).rejects.toThrow('stop here');

    expect(networkPassed()).toBe(network);
    expect((importWsdl.mock.calls[0]?.[1] as { auth?: unknown }).auth).toEqual({ type: 'kerberos' });
  });

  it('passes it on the Update Definition preview', async () => {
    importWsdl.mockRejectedValue(new Error('stop here'));
    const service = new EngineService(vi.fn(), network);

    await expect(service.importPreview(URL_SOURCE)).rejects.toThrow('stop here');

    expect(networkPassed()).toBe(network);
  });

  it('passes nothing when the app wired no network', async () => {
    importWsdl.mockRejectedValue(new Error('stop here'));
    const service = new EngineService(vi.fn());

    await expect(service.importPreview(URL_SOURCE)).rejects.toThrow('stop here');

    expect(importWsdl.mock.calls[0]?.[1]).not.toHaveProperty('network');
  });

  it('resolves the network for a legacy import fallback fetch', async () => {
    const refusing = vi.fn(() => Promise.reject(new Error('no route')));
    const service = new EngineService(vi.fn(), refusing);

    await expect(service.networkFetchDocument()(URL_SOURCE.url)).rejects.toThrow();

    expect(refusing).toHaveBeenCalledWith(URL_SOURCE.url);
  });
});
