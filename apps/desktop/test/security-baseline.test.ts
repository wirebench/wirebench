import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from './helpers/fixtures.js';
import { FLOW_TIMEOUT_MS, OAuth2Service } from '../src/main/oauth2.js';
import {
  APP_SCHEME,
  APP_SCHEME_HOST,
  APP_SCHEME_PRIVILEGES,
  CONTENT_SECURITY_POLICY,
  MAIN_WINDOW_WEB_PREFERENCES,
  isExternalUrlAllowed,
} from '../src/main/security.js';

describe('security baseline', () => {
  it('locks down BrowserWindow webPreferences', () => {
    expect(MAIN_WINDOW_WEB_PREFERENCES).toMatchInlineSnapshot(`
      {
        "allowRunningInsecureContent": false,
        "contextIsolation": true,
        "nodeIntegration": false,
        "sandbox": true,
        "webSecurity": true,
      }
    `);
  });

  it('sets a strict content security policy', () => {
    expect(CONTENT_SECURITY_POLICY).toMatchInlineSnapshot(
      `"default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:"`,
    );
  });

  it.each(['http://example.com', 'https://example.com'])('allows %s', (url) => {
    expect(isExternalUrlAllowed(url)).toBe(true);
  });

  it.each(['file:///etc/passwd', 'javascript:alert(1)', 'mailto:a@b.com'])('rejects %s', (url) => {
    expect(isExternalUrlAllowed(url)).toBe(false);
  });

  it('registers the app:// scheme as standard, secure, and fetch-capable', () => {
    expect(APP_SCHEME).toBe('app');
    expect(APP_SCHEME_HOST).toBe('wirebench');
    expect(APP_SCHEME_PRIVILEGES).toMatchInlineSnapshot(`
      {
        "corsEnabled": false,
        "secure": true,
        "standard": true,
        "stream": true,
        "supportFetchAPI": true,
      }
    `);
  });
});

/**
 * The OAuth2 callback listener. A loopback redirect is the only safe shape for a desktop client
 * (RFC 8252 §7.3), and every property below is one an attacker would want relaxed: a listener on a
 * routable address accepts somebody else's authorization code, one that outlives the flow is a port
 * left open for the session, and one that skips `state` accepts a code the user never asked for.
 */
describe('the OAuth2 loopback listener', () => {
  const source = readFileSync(join(REPO_ROOT, 'apps/desktop/src/main/loopback-callback.ts'), 'utf8');

  it('binds the loopback address and nothing else', () => {
    const listens = source.match(/\.listen\([^)]*\)/g) ?? [];
    expect(listens).toHaveLength(1);
    expect(listens[0]).toContain("'127.0.0.1'");
  });

  it('names a loopback redirect URI, with a random port unless one was pinned', () => {
    const random = new OAuth2Service({ openExternal: () => Promise.resolve() });
    expect(random.redirectUri()).toBe('http://127.0.0.1:<random port>/callback');

    const pinned = new OAuth2Service({ openExternal: () => Promise.resolve(), callbackPort: () => 8123 });
    expect(pinned.redirectUri()).toBe('http://127.0.0.1:8123/callback');
  });

  it('gives up on a flow nobody completes', () => {
    expect(FLOW_TIMEOUT_MS).toBe(5 * 60 * 1000);
  });

  it('requires the state it issued before it accepts a code', () => {
    expect(source).toContain('params.get(options.expected.name) !== expected');
  });
});
