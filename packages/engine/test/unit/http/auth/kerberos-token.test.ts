import { describe, expect, it, vi } from 'vitest';
import { HttpError } from '../../../../src/errors.js';
import {
  defaultSpn,
  kerberosToken,
  negotiateBearer,
  normaliseSpn,
  startKerberosContext,
  withNegotiate,
} from '../../../../src/http/auth/kerberos-token.js';
import { fakeKerberos } from '../../../helpers/fake-kerberos.js';

describe('normaliseSpn', () => {
  it.each([
    ['HTTP/svc.corp', 'win32', 'HTTP/svc.corp'],
    ['HTTP@svc.corp', 'win32', 'HTTP/svc.corp'],
    ['svc.corp', 'win32', 'HTTP/svc.corp'],
    ['HTTP/svc.corp', 'darwin', 'HTTP@svc.corp'],
    ['host/sts.corp', 'linux', 'host@sts.corp'],
    ['svc.corp', 'linux', 'HTTP@svc.corp'],
    ['HTTP/svc.corp@CORP.EXAMPLE', 'win32', 'HTTP/svc.corp@CORP.EXAMPLE'],
    ['HTTP/svc.corp@CORP.EXAMPLE', 'linux', 'HTTP@svc.corp'],
    ['HTTP/svc.corp@CORP.EXAMPLE', 'darwin', 'HTTP@svc.corp'],
  ] as const)('%s on %s → %s', (spn, platform, expected) => {
    expect(normaliseSpn(spn, platform)).toBe(expected);
  });

  it('defaults to HTTP and the hostname, without the port', () => {
    expect(defaultSpn('https://svc.corp:8443/a?b')).toBe('HTTP@svc.corp');
  });
});

describe('startKerberosContext', () => {
  it('asks in the platform form and returns the first token', async () => {
    const provider = fakeKerberos();
    const context = await startKerberosContext('HTTP@svc', {}, { provider, platform: 'win32' });
    expect(provider.inits).toEqual([{ spn: 'HTTP/svc' }]);
    expect(context.spn).toBe('HTTP/svc');
    expect(Buffer.from(context.token).toString()).toBe('ap-req');
  });

  it('passes an explicit account on Windows', async () => {
    const provider = fakeKerberos();
    await startKerberosContext('svc', { username: 'u', domain: 'D', password: 'p' }, { provider, platform: 'win32' });
    expect(provider.inits).toEqual([{ spn: 'HTTP/svc', user: 'u', domain: 'D', password: 'p' }]);
  });

  it.each(['darwin', 'linux'] as const)(
    'refuses an explicit account on %s before touching the provider',
    async (platform) => {
      const provider = fakeKerberos();
      await expect(startKerberosContext('svc', { username: 'u' }, { provider, platform })).rejects.toMatchObject({
        code: 'kerberos-explicit-credentials-unsupported',
      });
      expect(provider.inits).toEqual([]);
    },
  );

  it('passes a principal on GSSAPI only', async () => {
    const provider = fakeKerberos();
    await startKerberosContext('svc', { principal: 'alice@CORP' }, { provider, platform: 'linux' });
    await startKerberosContext('svc', { principal: 'alice@CORP' }, { provider, platform: 'win32' });
    expect(provider.inits).toEqual([{ spn: 'HTTP@svc', principal: 'alice@CORP' }, { spn: 'HTTP/svc' }]);
  });

  it('refuses when the provider is unavailable, with its reason', async () => {
    const provider = fakeKerberos({ unavailable: 'The Kerberos component is not installed.' });
    await expect(startKerberosContext('svc', {}, { provider, platform: 'linux' })).rejects.toMatchObject({
      code: 'kerberos-unavailable',
      message: 'The Kerberos component is not installed.',
    });
  });

  it.each([
    ['No Kerberos credentials available (default cache: FILE:/tmp/x)', 'kerberos-no-credentials'],
    ['No credentials were supplied, or the credentials were unavailable or inaccessible', 'kerberos-no-credentials'],
    ['InitializeSecurityContext: No credentials are available in the security package', 'kerberos-no-credentials'],
    ['Server not found in Kerberos database', 'kerberos-unknown-spn'],
    ['InitializeSecurityContext: The specified target is unknown or unreachable', 'kerberos-unknown-spn'],
    ['InitializeSecurityContext: The target principal name is incorrect.', 'kerberos-unknown-spn'],
    ['SEC_E_TARGET_UNKNOWN', 'kerberos-unknown-spn'],
    ['Clock skew too great', 'kerberos-clock-skew'],
    ['InitializeSecurityContext: The clocks on the client and server machines are skewed.', 'kerberos-clock-skew'],
    ['Something else entirely', 'kerberos-failed'],
  ])('maps "%s" to %s, naming the SPN and keeping the OS text', async (osMessage, code) => {
    const provider = fakeKerberos({ initError: osMessage });
    await expect(startKerberosContext('svc', {}, { provider, platform: 'linux' })).rejects.toMatchObject({
      code,
      details: { spn: 'HTTP@svc', osMessage },
    });
  });

  it('verifies a reply token, and fails a bad one as kerberos-mutual-auth-failed', async () => {
    const good = await startKerberosContext('svc', {}, { provider: fakeKerberos(), platform: 'linux' });
    await expect(good.verify(Buffer.from('ap-rep'))).resolves.toBeUndefined();
    const bad = await startKerberosContext(
      'svc',
      {},
      { provider: fakeKerberos({ verifyFails: true }), platform: 'linux' },
    );
    await expect(bad.verify(Buffer.from('ap-rep'))).rejects.toMatchObject({ code: 'kerberos-mutual-auth-failed' });
  });
});

describe('kerberosToken and negotiateBearer', () => {
  it('kerberosToken returns the raw bytes of the first step', async () => {
    const token = await kerberosToken('host/sts.corp', {}, { provider: fakeKerberos(), platform: 'linux' });
    expect(Buffer.from(token).toString()).toBe('ap-req');
  });

  it('negotiateBearer derives the SPN from the URL unless one is set', async () => {
    const provider = fakeKerberos();
    await expect(
      negotiateBearer({ type: 'kerberos' }, 'wss://svc.corp:9443/ws', { provider, platform: 'linux' }),
    ).resolves.toEqual({ type: 'bearer', scheme: 'Negotiate', token: Buffer.from('ap-req').toString('base64') });
    await negotiateBearer({ type: 'kerberos', spn: 'HTTP/alias.corp' }, 'https://svc.corp', {
      provider,
      platform: 'linux',
    });
    expect(provider.inits.map((init) => init.spn)).toEqual(['HTTP@svc.corp', 'HTTP@alias.corp']);
  });
});

describe('blank Kerberos fields', () => {
  it('refuses a blank SPN as kerberos-unknown-spn before asking the provider', async () => {
    const provider = fakeKerberos();
    await expect(startKerberosContext(' ', {}, { provider, platform: 'linux' })).rejects.toMatchObject({
      code: 'kerberos-unknown-spn',
    });
    expect(provider.inits).toEqual([]);
  });

  it('a blank username or password on linux is unset, not refused', async () => {
    const provider = fakeKerberos();
    await startKerberosContext('svc', { username: '', password: ' ', principal: '' }, { provider, platform: 'linux' });
    expect(provider.inits).toEqual([{ spn: 'HTTP@svc' }]);
  });

  it('a blank account on Windows passes nothing', async () => {
    const provider = fakeKerberos();
    await startKerberosContext('svc', { username: ' ', domain: '', password: '' }, { provider, platform: 'win32' });
    expect(provider.inits).toEqual([{ spn: 'HTTP/svc' }]);
  });

  it("negotiateBearer takes a blank SPN as the URL's default", async () => {
    const provider = fakeKerberos();
    await negotiateBearer({ type: 'kerberos', spn: ' ' }, 'https://svc.corp/a', { provider, platform: 'linux' });
    expect(provider.inits.map((init) => init.spn)).toEqual(['HTTP@svc.corp']);
  });
});

describe('defaultSpn with a bad URL', () => {
  it('fails as kerberos-unknown-spn rather than a TypeError', () => {
    expect(() => defaultSpn('not a url')).toThrow(
      expect.objectContaining({ code: 'kerberos-unknown-spn', details: { url: 'not a url' } }),
    );
  });
});

describe('withNegotiate', () => {
  it('turns Kerberos into one preemptive Negotiate bearer', async () => {
    await expect(
      withNegotiate({ type: 'kerberos' }, 'wss://svc.corp/ws', { provider: fakeKerberos(), platform: 'linux' }),
    ).resolves.toEqual({ type: 'bearer', scheme: 'Negotiate', token: Buffer.from('ap-req').toString('base64') });
  });

  it('leaves every other scheme alone', async () => {
    const basic = { type: 'basic', username: 'u', password: 'p', preemptive: true } as const;
    await expect(withNegotiate(basic, 'wss://x')).resolves.toBe(basic);
    await expect(withNegotiate(undefined, 'wss://x')).resolves.toBeUndefined();
  });
});

describe('the token wait (#267)', () => {
  const spn = process.platform === 'win32' ? 'HTTP/svc' : 'HTTP@svc';

  it.each(['init', 'step'] as const)('times a hung %s out with the Kerberos message', async (hang) => {
    const provider = fakeKerberos({ hang });
    const error = await kerberosToken('HTTP/svc', {}, { provider, timeoutMs: 20 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpError);
    expect(error).toMatchObject({
      code: 'timeout',
      message: `Timed out waiting for a Kerberos ticket for ${spn}.`,
      details: { spn, stage: 'kerberos' },
    });
    provider.release();
  });

  it('times a hung verify out on its own limit', async () => {
    const provider = fakeKerberos({ hang: 'verify' });
    const context = await startKerberosContext('HTTP/svc', {}, { provider, timeoutMs: 1000 });
    await expect(context.verify(Buffer.from('ap-rep'), { timeoutMs: 20 })).rejects.toMatchObject({
      code: 'timeout',
      details: { spn, stage: 'kerberos' },
    });
    provider.release();
  });

  it('rejects at once with aborted when the signal fires while the call hangs', async () => {
    const provider = fakeKerberos({ hang: 'init' });
    const controller = new AbortController();
    const pending = kerberosToken('HTTP/svc', {}, { provider, signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({
      code: 'aborted',
      message: 'The request was aborted.',
      details: { spn, stage: 'kerberos' },
    });
    provider.release();
  });

  it('never touches the provider for an aborted signal or a spent budget', async () => {
    const provider = fakeKerberos();
    await expect(kerberosToken('HTTP/svc', {}, { provider, signal: AbortSignal.abort() })).rejects.toMatchObject({
      code: 'aborted',
    });
    await expect(kerberosToken('HTTP/svc', {}, { provider, timeoutMs: 0 })).rejects.toMatchObject({ code: 'timeout' });
    expect(provider.inits).toEqual([]);
  });

  it('has no limit without options', async () => {
    const provider = fakeKerberos({ hang: 'init' });
    const pending = kerberosToken('HTTP/svc', {}, { provider });
    setTimeout(() => provider.release(), 50);
    await expect(pending).resolves.toBeInstanceOf(Uint8Array);
  });

  it('refuses a third call while two abandoned calls still run, and accepts one once they end', async () => {
    const provider = fakeKerberos({ hang: 'init' });
    for (let i = 0; i < 2; i += 1) {
      await expect(kerberosToken('HTTP/svc', {}, { provider, timeoutMs: 10 })).rejects.toMatchObject({
        code: 'timeout',
      });
    }
    await expect(kerberosToken('HTTP/svc', {}, { provider, timeoutMs: 10 })).rejects.toMatchObject({
      code: 'kerberos-failed',
      message: 'Kerberos is still waiting on earlier requests to the Kerberos server; try again shortly.',
      details: { spn, abandoned: 2 },
    });
    expect(provider.inits).toHaveLength(2);
    provider.release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const pending = kerberosToken('HTTP/svc', {}, { provider, timeoutMs: 1000 });
    provider.release();
    await expect(pending).resolves.toBeInstanceOf(Uint8Array);
  });

  it('still verifies a reply while two earlier calls are abandoned (#267)', async () => {
    const provider = fakeKerberos({ hang: 'init' });
    const made = startKerberosContext('HTTP/svc', {}, { provider });
    provider.release();
    const context = await made;
    for (let i = 0; i < 2; i += 1) {
      await expect(kerberosToken('HTTP/svc', {}, { provider, timeoutMs: 10 })).rejects.toMatchObject({
        code: 'timeout',
      });
    }
    await expect(context.verify(new Uint8Array([1]), { timeoutMs: 1000 })).resolves.toBeUndefined();
    provider.release();
  });

  it('counts an abandoned call that later fails as ended, with no unhandled rejection', async () => {
    const provider = fakeKerberos({ hang: 'init' });
    await expect(kerberosToken('HTTP/svc', {}, { provider, timeoutMs: 10 })).rejects.toMatchObject({ code: 'timeout' });
    await expect(kerberosToken('HTTP/svc', {}, { provider, timeoutMs: 10 })).rejects.toMatchObject({ code: 'timeout' });
    provider.fail();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const pending = kerberosToken('HTTP/svc', {}, { provider, timeoutMs: 1000 });
    provider.release();
    await expect(pending).resolves.toBeInstanceOf(Uint8Array);
  });

  it('removes its abort listener once the call settles', async () => {
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, 'addEventListener');
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    await kerberosToken('HTTP/svc', {}, { provider: fakeKerberos(), signal: controller.signal, timeoutMs: 1000 });
    expect(add).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith('abort', add.mock.calls[0]![1]);
  });
});
