// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { version as manifestVersion } from '../package.json' with { type: 'json' };

const { appVersion } = await import('../../../packages/host/src/app-version.js');

const app = (packaged: boolean) => ({ packaged: () => packaged, version: () => '9.9.9' });

describe('appVersion', () => {
  it('reports what the packaged bundle carries', () => {
    expect(appVersion(app(true))).toBe('9.9.9');
  });

  it('falls back to the manifest when unpackaged, where Electron only knows `0.0`', () => {
    expect(appVersion(app(false))).toBe(manifestVersion);
    expect(appVersion(app(false))).not.toBe('0.0');
  });
});
