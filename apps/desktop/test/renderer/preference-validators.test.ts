import { describe, expect, it } from 'vitest';
import { headerValueProblem, proxyHostProblem } from '../../src/renderer/features/preferences/validators.js';

describe('proxyHostProblem', () => {
  it.each(['', 'proxy', 'proxy.corp.example', '10.0.0.1', '::1', 'fe80::1', '[::1]', '[fe80::1%en0]'])(
    'accepts %j',
    (host) => {
      expect(proxyHostProblem(host)).toBeUndefined();
    },
  );

  it.each(['http://proxy', 'proxy:3128', 'proxy/path', 'my proxy', 'user@proxy', '10.0.0.1:8080'])(
    'refuses %j',
    (host) => {
      expect(proxyHostProblem(host)).toBe('Host name or IP only — set the port below');
    },
  );
});

describe('headerValueProblem', () => {
  it('accepts ordinary values, including a tab', () => {
    expect(headerValueProblem('Wirebench/1.0 (+https://example.com)')).toBeUndefined();
    expect(headerValueProblem('a\tb')).toBeUndefined();
  });

  it.each(['a\nb', 'a\rb', 'a\u0000b', 'a\u007fb'])('refuses %j', (value) => {
    expect(headerValueProblem(value)).toMatch(/Control characters/);
  });
});
