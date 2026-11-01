/**
 * Theme: choose colour theme… — the command palette's `palette` mode. Moving the highlight previews a
 * colour theme across the window, Monaco included, without writing anything; Escape puts back the one
 * that was active; Enter keeps the highlighted one through preferences.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@monaco-editor/react', async () => await import('../mocks/monaco-editor-react.js'));
vi.mock('../../src/renderer/editor/monaco.js', async () => await import('../mocks/monaco-runtime.js'));

import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { CodeEditor } from '../../src/renderer/editor/code-editor.js';
import { registerViewCommands } from '../../src/renderer/commands/register-view-commands.js';
import { getCommand, resetCommands, runCommand, type CommandContext } from '../../src/renderer/lib/commands.js';
import { applyPalette } from '../../src/renderer/lib/theme.js';
import { CommandPalette } from '../../src/renderer/shell/command-palette.js';
import { usePreferencesStore } from '../../src/renderer/state/preferences.js';
import { DEFAULT_PREFERENCES_WIRE } from '../../src/renderer/state/preferences-defaults.js';
import { useUiStore } from '../../src/renderer/state/ui.js';
import { DEFAULT_UI_STATE } from '../../src/renderer/state/ui-state.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';
import type { PreferencesPatchWire, PreferencesWire } from '@wirebench/wire/wire-base';

const context: CommandContext = {
  platform: 'mac',
  ui: {
    sidebar: DEFAULT_UI_STATE.sidebar,
    console: DEFAULT_UI_STATE.console,
    slideOver: DEFAULT_UI_STATE.slideOver,
    theme: DEFAULT_UI_STATE.theme,
    palette: DEFAULT_UI_STATE.palette,
    editorLineNumbers: DEFAULT_UI_STATE.editorLineNumbers,
    editorLayout: DEFAULT_UI_STATE.editorLayout,
  },
  selection: undefined,
};

/** The shell's part: owns `open`, as `AppShell` does. */
function Host({ withEditor = false }: { readonly withEditor?: boolean }) {
  const [open, setOpen] = useState(true);
  return (
    <>
      {withEditor && <CodeEditor value="" language="xml" ariaLabel="Body" />}
      <CommandPalette open={open} onOpenChange={setOpen} context={context} mode="palette" />
    </>
  );
}

const html = (): HTMLElement => document.documentElement;
const input = (): HTMLElement => screen.getByTestId('quick-open-input');
const press = (key: string): void => {
  fireEvent.keyDown(input(), { key });
};

/** Replies with the defaults under the patch's `ui`, the way main's merge would. */
function stubUpdate() {
  return vi.fn((request: { patch: PreferencesPatchWire }) => {
    const preferences: PreferencesWire = {
      ...DEFAULT_PREFERENCES_WIRE,
      ui: { ...DEFAULT_PREFERENCES_WIRE.ui, ...(request.patch.ui as Partial<PreferencesWire['ui']>) },
    };
    return Promise.resolve({ ok: true as const, value: { preferences } });
  });
}

let update: ReturnType<typeof stubUpdate>;

beforeEach(() => {
  update = stubUpdate();
  installWirebenchApi({ preferences: { update } });
  usePreferencesStore.setState({ preferences: DEFAULT_PREFERENCES_WIRE, loaded: true });
  act(() => {
    useUiStore.getState().setPalette('default');
  });
  applyPalette('default');
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  resetCommands();
  act(() => {
    useUiStore.getState().setPalette('default');
  });
  applyPalette('default');
});

describe('Theme: choose colour theme…', () => {
  it('is a View command that opens the picker', async () => {
    const openPalette = vi.fn();
    registerViewCommands(openPalette);
    const command = getCommand('view.choosePalette');
    expect(command?.label).toBe('Theme: choose colour theme…');
    expect(command?.shortcut).toBeUndefined();
    await runCommand('view.choosePalette', context);
    expect(openPalette).toHaveBeenCalledWith('palette');
  });

  it('lists the ten colour themes, the current one marked and highlighted', () => {
    act(() => {
      useUiStore.getState().setPalette('sandstone');
    });
    render(<Host />);
    const items = screen.getAllByTestId('palette-colour-theme');
    expect(items.map((item) => item.dataset['colourTheme'])).toEqual([
      'default',
      'field-kit',
      'sandstone',
      'dusk',
      'seed',
      'pith',
      'rind',
      'plume',
      'kiln',
      'trail',
    ]);
    expect(items.map((item) => item.querySelector('span')?.textContent)).toEqual([
      'Default',
      'Field kit',
      'Sandstone',
      'Dusk',
      'Seed',
      'Pith',
      'Rind',
      'Plume',
      'Kiln',
      'Trail',
    ]);
    const current = items.find((item) => item.dataset['current'] === 'true');
    expect(current?.dataset['colourTheme']).toBe('sandstone');
    expect(current?.getAttribute('aria-selected')).toBe('true');
  });

  it('previews as the highlight moves, writing nothing', () => {
    render(<Host />);
    const stored = localStorage.getItem('wirebench.ui');
    press('ArrowDown');
    expect(html().dataset['palette']).toBe('field-kit');
    press('ArrowDown');
    press('ArrowDown');
    expect(html().dataset['palette']).toBe('dusk');
    expect(update).not.toHaveBeenCalled();
    expect(usePreferencesStore.getState().preferences.ui.palette).toBe('default');
    expect(useUiStore.getState().palette).toBe('default');
    expect(localStorage.getItem('wirebench.ui')).toBe(stored);
  });

  it('recolours a code editor while previewing, and puts it back on Escape', () => {
    render(<Host withEditor />);
    expect(screen.getByLabelText('Body').dataset['theme']).toBe('wirebench-dark');
    press('ArrowDown');
    expect(screen.getByLabelText('Body').dataset['theme']).toBe('wirebench-field-kit-dark');
    press('Escape');
    expect(screen.getByLabelText('Body').dataset['theme']).toBe('wirebench-dark');
  });

  it('Escape after several previews restores the colour theme that was active', () => {
    act(() => {
      useUiStore.getState().setPalette('pith');
    });
    applyPalette('pith');
    render(<Host />);
    press('ArrowDown');
    press('ArrowUp');
    press('ArrowUp');
    expect(html().dataset['palette']).toBe('seed');
    press('Escape');
    expect(screen.queryByTestId('quick-open-input')).toBeNull();
    expect(html().dataset['palette']).toBe('pith');
    expect(update).not.toHaveBeenCalled();
  });

  it('Escape back to Default removes the attribute', () => {
    render(<Host />);
    press('ArrowUp');
    expect(html().dataset['palette']).toBe('trail');
    press('Escape');
    expect(html().hasAttribute('data-palette')).toBe(false);
  });

  it('Enter keeps the highlighted colour theme, through preferences', async () => {
    render(<Host withEditor />);
    press('ArrowDown');
    press('ArrowDown');
    press('ArrowDown');
    press('Enter');
    expect(screen.queryByTestId('quick-open-input')).toBeNull();
    expect(update).toHaveBeenCalledWith({ patch: { ui: { palette: 'dusk' } } });
    await vi.waitFor(() => {
      expect(useUiStore.getState().palette).toBe('dusk');
    });
    expect(html().dataset['palette']).toBe('dusk');
    expect(screen.getByLabelText('Body').dataset['theme']).toBe('wirebench-dusk-dark');
  });
});
