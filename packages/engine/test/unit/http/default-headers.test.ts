import { describe, expect, it } from 'vitest';
import { defaultUserAgent, isDefaultUserAgent } from '#core/http/default-headers';

describe('defaultUserAgent', () => {
  it('names the version when the host knows it, and only the product when it does not', () => {
    expect(defaultUserAgent('6.1.0')).toBe('Wirebench/6.1.0');
    expect(defaultUserAgent()).toBe('Wirebench');
    expect(defaultUserAgent('')).toBe('Wirebench');
  });
});

describe('isDefaultUserAgent', () => {
  it('knows every default a release has written, and nothing a user would type', () => {
    for (const value of ['Wirebench', 'Wirebench/0.1', 'Wirebench/6.1.0', 'Wirebench/6.1.0-rc.3']) {
      expect(isDefaultUserAgent(value)).toBe(true);
    }
    for (const value of ['', 'wirebench', 'Wirebench/', 'Wirebench/6.1.0 (ci)', 'Mozilla/5.0', 'Wirebench/x']) {
      expect(isDefaultUserAgent(value)).toBe(false);
    }
  });
});
