import { Agent, ProxyAgent } from 'undici';
import { afterEach, describe, expect, it } from 'vitest';
import { createDispatcher, proxyAgentOptionsFor } from '../../../src/http/client.js';

describe('createDispatcher', () => {
  const created: { close(): Promise<void> }[] = [];

  afterEach(async () => {
    await Promise.all(created.splice(0).map((d) => d.close()));
  });

  it('returns a plain Agent when no tls/proxy options are given', () => {
    const dispatcher = createDispatcher({});
    created.push(dispatcher);
    expect(dispatcher).toBeInstanceOf(Agent);
  });

  it('returns an Agent configured with TLS connect options', () => {
    const dispatcher = createDispatcher({ tls: { rejectUnauthorized: false, ca: ['pem'] } });
    created.push(dispatcher);
    expect(dispatcher).toBeInstanceOf(Agent);
  });

  it('returns a ProxyAgent when proxy options are given, with basic auth', () => {
    const dispatcher = createDispatcher({
      proxy: { url: 'http://proxy.test:8080', auth: { username: 'u', password: 'p' } },
    });
    created.push(dispatcher);
    expect(dispatcher).toBeInstanceOf(ProxyAgent);
  });

  it('returns a ProxyAgent with TLS connect options and no auth', () => {
    const dispatcher = createDispatcher({ proxy: { url: 'http://proxy.test:8080' }, tls: { minVersion: 'TLSv1.3' } });
    created.push(dispatcher);
    expect(dispatcher).toBeInstanceOf(ProxyAgent);
  });
});

/**
 * The tunnelled origin handshake is built from `requestTls`, and undici's connector defaults
 * `allowH2` to *true* when the option is absent — so leaving it out offered `h2` in the ALPN of
 * every proxied HTTPS request, including the ones whose client speaks HTTP/1.1 only. The flag
 * has to be stated, both ways.
 */
describe('proxyAgentOptionsFor', () => {
  it('carries allowH2 into the tunnelled requestTls, not just the agent', () => {
    const options = proxyAgentOptionsFor({ url: 'http://proxy.test:8080' }, { tls: { minVersion: 'TLSv1.3' } }, true);
    expect(options.requestTls).toMatchObject({ allowH2: true, minVersion: 'TLSv1.3' });
    expect(options.allowH2).toBe(true);
  });

  it('pins the tunnelled handshake to HTTP/1.1 when h2 is off', () => {
    const options = proxyAgentOptionsFor({ url: 'http://proxy.test:8080' }, { tls: { minVersion: 'TLSv1.2' } }, false);
    expect(options.requestTls).toMatchObject({ allowH2: false });
    expect(options.allowH2).toBeUndefined();
  });

  it('states allowH2 even when the send carries no TLS options of its own', () => {
    const options = proxyAgentOptionsFor({ url: 'http://proxy.test:8080' }, {}, false);
    expect(options.requestTls).toEqual({ allowH2: false });
  });

  it('keeps the bind address on the hop to the proxy, never on the tunnelled handshake', () => {
    const options = proxyAgentOptionsFor({ url: 'http://proxy.test:8080' }, { localAddress: '10.0.0.9' }, false);
    expect(options.proxyTls).toEqual({ localAddress: '10.0.0.9' });
    expect(options.requestTls).not.toHaveProperty('localAddress');
  });
});
