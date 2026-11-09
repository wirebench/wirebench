import { describe, expect, it } from 'vitest';
import { BROWSER_DEVICE_NAME, browserDeviceName } from '../../../src/identity/device-name.js';

const AGENTS: readonly (readonly [string, string])[] = [
  [
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
    'Chrome on macOS',
  ],
  [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36 Edg/142.0.0.0',
    'Edge on Windows',
  ],
  ['Mozilla/5.0 (X11; Linux x86_64; rv:144.0) Gecko/20100101 Firefox/144.0', 'Firefox on Linux'],
  [
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Safari/605.1.15',
    'Safari on macOS',
  ],
  [
    'Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Mobile/15E148 Safari/604.1',
    'Safari on iOS',
  ],
  [
    'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36',
    'Chrome on Android',
  ],
];

describe('browserDeviceName (#900)', () => {
  it.each(AGENTS)('names %j as %s', (agent, name) => {
    expect(browserDeviceName(agent)).toBe(name);
  });

  it('falls back to Web browser for an agent it cannot read, none at all, or a repeated header', () => {
    expect(browserDeviceName('curl/8.9.1')).toBe(BROWSER_DEVICE_NAME);
    expect(browserDeviceName('lightMyRequest')).toBe(BROWSER_DEVICE_NAME);
    expect(browserDeviceName(undefined)).toBe(BROWSER_DEVICE_NAME);
    expect(browserDeviceName(['a', 'b'])).toBe(BROWSER_DEVICE_NAME);
    expect(browserDeviceName(`Chrome/1 ${'x'.repeat(2000)}`)).toBe(BROWSER_DEVICE_NAME);
  });
});
