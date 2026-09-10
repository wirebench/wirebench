import { Agent, ProxyAgent } from 'undici';
import { afterEach, describe, expect, it } from 'vitest';
import { createDispatcher } from '../../../src/http/client.js';

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
