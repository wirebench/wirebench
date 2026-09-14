// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { version as manifestVersion } from '../package.json' with { type: 'json' };

const electron = { app: { getVersion: () => '9.9.9', isPackaged: true } };

vi.mock('electron', () => electron);

const { appVersion } = await import('../src/main/app-version.js');

describe('appVersion', () => {
  it('reports what the packaged bundle carries', () => {
    electron.app.isPackaged = true;
    expect(appVersion()).toBe('9.9.9');
  });

  it('falls back to the manifest when unpackaged, where Electron only knows `0.0`', () => {
    electron.app.isPackaged = false;
    expect(appVersion()).toBe(manifestVersion);
    expect(appVersion()).not.toBe('0.0');
  });
});
