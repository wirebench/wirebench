import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { ProxySection } from '../../src/renderer/features/preferences/network-section.js';
import { sectionById, subtitleOf } from '../../src/renderer/features/preferences/settings-model.js';
import { DEFAULT_PREFERENCES_WIRE } from '../../src/renderer/state/preferences-defaults.js';
import type { PreferencesWire } from '@wirebench/wire/wire-base';
import { installWirebenchApi } from '../mocks/wirebench-api.js';

/** The API a browser tab's bootstrap installs: the server's capabilities, `env.host` browser. */
function asBrowserTab(): void {
  const api = installWirebenchApi();
  Object.defineProperty(api, 'env', {
    configurable: true,
    value: { e2e: false, osTheme: 'dark', host: 'browser', capabilities: ['send:public'] },
  });
}

const withMode = (mode: PreferencesWire['proxy']['mode']): PreferencesWire => ({
  ...DEFAULT_PREFERENCES_WIRE,
  proxy: { ...DEFAULT_PREFERENCES_WIRE.proxy, mode },
});

const proxyText = (preferences: PreferencesWire): string =>
  render(<ProxySection preferences={preferences} update={() => undefined} />).container.textContent ?? '';

describe('App settings in a browser tab (#901)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('says Features are yours on this server in a browser tab, and this machine on the desktop', () => {
    installWirebenchApi();
    expect(subtitleOf(sectionById('features'))).toContain('on this machine');
    asBrowserTab();
    expect(subtitleOf(sectionById('features'))).toBe(
      'Turn protocols and optional features off for you on this server.',
    );
  });

  it('offers System proxy on the desktop only', () => {
    installWirebenchApi();
    expect(proxyText(withMode('none'))).toContain('System proxy');
    cleanup();
    asBrowserTab();
    const text = proxyText(withMode('none'));
    expect(text).not.toContain('System proxy');
    expect(text).toContain('No proxy');
    expect(text).toContain('Manual');
  });

  it('shows a stored system mode in a browser tab as what it does: direct', () => {
    asBrowserTab();
    const text = proxyText(withMode('system'));
    expect(text).toContain('No proxy (direct)');
    expect(text).not.toContain('System proxy');
  });
});
