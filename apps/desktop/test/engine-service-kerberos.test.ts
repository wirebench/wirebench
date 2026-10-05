// @vitest-environment node
/** `definition.import` with Kerberos: no keychain read, and only `{ type: 'kerberos', spn? }` reaches the engine. */
import { afterEach, describe, expect, it, vi } from 'vitest';

const importWsdl = vi.fn();
vi.mock('@wirebench/engine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@wirebench/engine')>()),
  importWsdl: (...args: unknown[]) => importWsdl(...args) as unknown,
}));

const { EngineService } = await import('../src/main/engine-service.js');

afterEach(() => {
  importWsdl.mockReset();
});

describe('EngineService.importDefinition with Kerberos', () => {
  it('reads no secret and hands the engine the SPN only', async () => {
    importWsdl.mockRejectedValue(new Error('stop here'));
    const getSecret = vi.fn();
    const service = new EngineService(getSecret);

    await expect(
      service.importDefinition({
        source: { kind: 'url', url: 'http://example.test/service.wsdl' },
        options: { auth: { type: 'kerberos', spn: 'HTTP/wsdl.example.test' } },
      }),
    ).rejects.toThrow('stop here');

    expect(getSecret).not.toHaveBeenCalled();
    expect((importWsdl.mock.calls[0]?.[1] as { auth?: unknown }).auth).toEqual({
      type: 'kerberos',
      spn: 'HTTP/wsdl.example.test',
    });
  });

  it('drops a blank SPN', async () => {
    importWsdl.mockRejectedValue(new Error('stop here'));
    const service = new EngineService(vi.fn());

    await expect(
      service.importDefinition({
        source: { kind: 'url', url: 'http://example.test/service.wsdl' },
        options: { auth: { type: 'kerberos', spn: ' ' } },
      }),
    ).rejects.toThrow('stop here');

    expect((importWsdl.mock.calls[0]?.[1] as { auth?: unknown }).auth).toEqual({ type: 'kerberos' });
  });
});
