import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PluginsSection } from '../../src/renderer/features/preferences/sections/plugins-section.js';
import { FeaturesSection } from '../../src/renderer/features/preferences/sections/features-section.js';
import { DEFAULT_PREFERENCES_WIRE } from '../../src/renderer/state/preferences-defaults.js';
import type { PluginRowWire } from '../../src/shared/plugins-wire.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';

const ACME: PluginRowWire = {
  id: 'acme',
  name: 'Acme formats',
  version: '1.0.0',
  importers: [{ id: 'acme/collection', title: 'Acme collection', extensions: ['.acme'] }],
  reporters: [],
  codeGenerators: [{ id: 'acme/kotlin', title: 'Kotlin', language: 'kotlin' }],
  network: ['https://schemas.acme.example'],
  installedAt: '2026-10-23T10:00:00.000Z',
  loaded: true,
};

afterEach(() => {
  cleanup();
});

describe('Settings → Plugins (phase 7 §9)', () => {
  it('lists each plugin with what it contributes and the origins it may reach, and why one is skipped', async () => {
    installWirebenchApi({
      plugins: {
        list: vi.fn().mockResolvedValue({
          ok: true,
          value: {
            plugins: [ACME],
            skipped: [{ id: 'old', code: 'plugin-modified', message: 'old changed since it was installed' }],
            off: false,
          },
        }),
      },
    });
    render(<PluginsSection />);
    const row = await screen.findByTestId('plugin-row-acme');
    expect(row.textContent).toContain('Importer: Acme collection (.acme)');
    expect(row.textContent).toContain('Code generator: Kotlin');
    expect(screen.getByTestId('plugin-network-acme').textContent).toBe('Network: https://schemas.acme.example');
    expect(screen.getByTestId('plugin-skipped-old').textContent).toContain('old changed since it was installed');
  });

  it('shows a picked plugin before it installs it, and installs only on Install', async () => {
    const install = vi.fn().mockResolvedValue({ ok: true, value: { id: 'acme' } });
    installWirebenchApi({
      plugins: {
        list: vi.fn().mockResolvedValue({ ok: true, value: { plugins: [], skipped: [], off: false } }),
        stage: vi.fn().mockResolvedValue({ ok: true, value: { token: 't1', plugin: { ...ACME, loaded: false } } }),
        install,
      },
      dialogs: { openFolder: vi.fn().mockResolvedValue({ ok: true, value: { path: '/tmp/acme' } }) },
    });
    render(<PluginsSection />);
    fireEvent.click(await screen.findByTestId('plugin-install-folder'));
    const summary = await screen.findByTestId('plugin-install-summary');
    expect(summary.textContent).toContain('Network: https://schemas.acme.example');
    expect(install).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('plugin-install-confirm'));
    await waitFor(() => {
      expect(install).toHaveBeenCalledWith({ token: 't1' });
    });
  });

  it('groups plugin switches under Plugins in Settings → Features', async () => {
    const state = (id: string, title: string) => ({
      id,
      title,
      stage: 'stable' as const,
      requires: id === 'plugins' ? [] : ['plugins'],
      default: true,
      policy: false,
      enabled: true,
    });
    installWirebenchApi({
      app: {
        features: vi.fn().mockResolvedValue({
          ok: true,
          value: { states: [state('plugins', 'Plugins'), state('plugin:acme', 'Acme formats')] },
        }),
      },
    });
    render(<FeaturesSection preferences={DEFAULT_PREFERENCES_WIRE} update={vi.fn()} />);
    await screen.findByTestId('feature-switch-plugin:acme');
    const headings = screen.getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent);
    expect(headings).toEqual(['Plugins']);
  });
});
