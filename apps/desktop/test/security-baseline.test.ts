import { describe, expect, it } from 'vitest';
import { CONTENT_SECURITY_POLICY, MAIN_WINDOW_WEB_PREFERENCES, isExternalUrlAllowed } from '../src/main/security.js';

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
});
