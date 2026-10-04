import { describe, expect, it } from 'vitest';
import { CookieJar, jarCookieHost } from '@wirebench/engine';
import { cliSendHost } from '../../src/send-host.js';

const base = { getSecret: () => Promise.resolve(undefined), onSecretValue: () => undefined };

describe('cliSendHost', () => {
  it('chooses the proxy from the environment, asynchronously, and lends nothing else', async () => {
    const host = cliSendHost({ ...base, env: { HTTPS_PROXY: 'http://p:8080' } });
    expect(await host.proxyFor?.('https://api.test/x')).toEqual({ url: 'http://p:8080/' });
    expect(host.tokens).toBeUndefined();
    expect(host.preferences).toBeUndefined();
    expect(host.tls).toBeUndefined();
    expect(host.cookies).toBeUndefined();
  });

  it('lends the cookie jar it is given', () => {
    const cookies = jarCookieHost(new CookieJar());
    expect(cliSendHost({ ...base, env: {}, cookies }).cookies).toBe(cookies);
  });
});
