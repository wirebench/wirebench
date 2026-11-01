/**
 * Settings → Appearance → Theme: the colour theme cards above the mode. Each card is a radio whose
 * swatches are painted by the tokens inside a wrapper wearing that card's `data-palette`, so they
 * come from `tokens.css` and follow the current mode.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The Settings page registers the shell commands, which reach the Monaco-backed editor commands.
vi.mock('../../src/renderer/editor/monaco.js', async () => await import('../mocks/monaco-runtime.js'));

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { PALETTES } from '@shared/palettes.js';
import { AppearanceSection } from '../../src/renderer/features/preferences/sections/appearance-section.js';
import { PreferencesEditor } from '../../src/renderer/features/preferences/preferences-editor.js';
import { registerShellCommands } from '../../src/renderer/commands/register-shell-commands.js';
import { SettingsVariantProvider } from '../../src/renderer/components/settings-grid.js';
import { PALETTE_LABEL } from '../../src/renderer/lib/theme.js';
import { usePreferencesStore } from '../../src/renderer/state/preferences.js';
import { DEFAULT_PREFERENCES_WIRE } from '../../src/renderer/state/preferences-defaults.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';
import type { PreferencesWire } from '@wirebench/wire/wire-base';

const DEFAULTS = DEFAULT_PREFERENCES_WIRE;

function renderSection(preferences: PreferencesWire = DEFAULTS) {
  const update = vi.fn();
  render(
    <SettingsVariantProvider variant="card">
      <AppearanceSection preferences={preferences} update={update} />
    </SettingsVariantProvider>,
  );
  return update;
}

const withPalette = (palette: PreferencesWire['ui']['palette']): PreferencesWire => ({
  ...DEFAULTS,
  ui: { ...DEFAULTS.ui, palette },
});

describe('Appearance colour theme cards', () => {
  afterEach(() => {
    cleanup();
  });

  it('names every colour theme in the order of PALETTES', () => {
    expect(Object.keys(PALETTE_LABEL)).toEqual([...PALETTES]);
    expect(PALETTE_LABEL).toEqual({
      default: 'Default',
      'field-kit': 'Field kit',
      sandstone: 'Sandstone',
      dusk: 'Dusk',
      seed: 'Seed',
      pith: 'Pith',
      rind: 'Rind',
      plume: 'Plume',
    });
  });

  it('lists eight cards as radios, the current one checked', () => {
    renderSection(withPalette('dusk'));
    const group = screen.getByRole('radiogroup', { name: 'Colour theme' });
    const radios = within(group).getAllByRole('radio');
    expect(radios.map((radio) => radio.getAttribute('aria-label') ?? radio.textContent)).toEqual([
      'Default',
      'Field kit',
      'Sandstone',
      'Dusk',
      'Seed',
      'Pith',
      'Rind',
      'Plume',
    ]);
    expect(screen.getByTestId('preferences-palette-dusk').getAttribute('aria-checked')).toBe('true');
    expect(screen.getByTestId('preferences-palette-default').getAttribute('aria-checked')).toBe('false');
  });

  it("paints each card's swatches inside a wrapper wearing that card's palette and the current mode", () => {
    renderSection({ ...DEFAULTS, ui: { ...DEFAULTS.ui, theme: 'light' } });
    const card = screen.getByTestId('preferences-palette-sandstone');
    const wrapper = card.querySelector<HTMLElement>('[data-palette]');
    expect(wrapper?.dataset['palette']).toBe('sandstone');
    expect(wrapper?.dataset['theme']).toBe('light');
    const swatches = wrapper?.querySelectorAll<HTMLElement>('[data-swatch]') ?? [];
    expect(swatches).toHaveLength(5);
    for (const swatch of swatches) {
      expect(swatch.style.backgroundColor).toMatch(/^var\(--wb-/);
    }
    // Default's card wears `default` too, so a window in another palette still shows Default.
    const defaultWrapper = screen
      .getByTestId('preferences-palette-default')
      .querySelector<HTMLElement>('[data-palette]');
    expect(defaultWrapper?.dataset['palette']).toBe('default');
  });

  it('writes the clicked colour theme to preferences', () => {
    const update = renderSection();
    fireEvent.click(screen.getByTestId('preferences-palette-sandstone'));
    expect(update).toHaveBeenCalledWith({ ui: { palette: 'sandstone' } });
  });

  it('moves the selection with the arrow keys, wrapping at the ends', () => {
    const update = renderSection(withPalette('dusk'));
    fireEvent.keyDown(screen.getByTestId('preferences-palette-dusk'), { key: 'ArrowRight' });
    expect(update).toHaveBeenLastCalledWith({ ui: { palette: 'seed' } });
    fireEvent.keyDown(screen.getByTestId('preferences-palette-dusk'), { key: 'ArrowLeft' });
    expect(update).toHaveBeenLastCalledWith({ ui: { palette: 'sandstone' } });
    cleanup();
    const again = renderSection(withPalette('default'));
    fireEvent.keyDown(screen.getByTestId('preferences-palette-default'), { key: 'ArrowUp' });
    expect(again).toHaveBeenLastCalledWith({ ui: { palette: 'plume' } });
  });

  it('only the checked card is in the tab order', () => {
    renderSection(withPalette('pith'));
    expect(screen.getByTestId('preferences-palette-pith').tabIndex).toBe(0);
    expect(screen.getByTestId('preferences-palette-seed').tabIndex).toBe(-1);
  });

  it('keeps the mode control, relabelled "Mode"', () => {
    const update = renderSection();
    const mode = screen.getByTestId('preferences-theme');
    expect(mode.getAttribute('role')).toBe('radiogroup');
    expect(document.getElementById(mode.getAttribute('aria-labelledby') ?? '')?.textContent).toBe('Mode');
    fireEvent.click(within(mode).getByRole('radio', { name: 'Light' }));
    expect(update).toHaveBeenCalledWith({ ui: { theme: 'light' } });
  });
});

describe('Settings search', () => {
  beforeEach(() => {
    installWirebenchApi();
    usePreferencesStore.setState({ preferences: DEFAULTS, loaded: true });
    registerShellCommands(() => undefined);
  });
  afterEach(() => {
    cleanup();
  });

  it('finds the colour theme', () => {
    render(<PreferencesEditor />);
    fireEvent.change(screen.getByLabelText('Search settings'), { target: { value: 'colour theme' } });
    const results = screen.getByTestId('settings-search-results');
    expect(within(results).getByRole('radiogroup', { name: 'Colour theme' })).toBeTruthy();
  });
});
