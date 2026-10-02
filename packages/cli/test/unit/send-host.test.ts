import { describe, expect, it } from 'vitest';
import { cliSendHost } from '../../src/send-host.js';

describe('cliSendHost', () => {
  it('chooses the proxy from the environment, asynchronously, and lends nothing else', async () => {
    const host = cliSendHost({
      getSecret: () => Promise.resolve(undefined),
      env: { HTTPS_PROXY: 'http://p:8080' },
      onSecretValue: () => undefined,
    });
    expect(await host.proxyFor?.('https://api.test/x')).toEqual({ url: 'http://p:8080/' });
    expect(host.tokens).toBeUndefined();
    expect(host.preferences).toBeUndefined();
    expect(host.tls).toBeUndefined();
  });
});
