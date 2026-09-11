import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/renderer/editor/monaco.js', async () => await import('../mocks/monaco-runtime.js'));

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { registerShellCommands } from '../../src/renderer/commands/register-shell-commands.js';
import { ShortcutsEditor } from '../../src/renderer/features/preferences/shortcuts-editor.js';
import type { CommandContext } from '../../src/renderer/lib/commands.js';
import { DEFAULT_PREFERENCES_WIRE } from '../../src/renderer/state/preferences-defaults.js';
import { usePreferencesStore } from '../../src/renderer/state/preferences.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';
import type { PreferencesWire } from '../../src/shared/wire-types.js';

const context: CommandContext = {
  platform: 'mac',
  ui: {
    sidebar: { visible: true, view: 'explorer', size: 20 },
    console: { visible: true, activeTab: 'http-log', size: 25 },
    details: { visible: true, size: 20, tab: 'selection', codeShell: 'posix' },
    theme: 'dark',
    editorLineNumbers: true,
    editorLayout: { orientation: 'side-by-side', mode: 'split' },
  },
  selection: undefined,
};

function withShortcuts(shortcuts: Readonly<Record<string, string>>): PreferencesWire {
  return { ...DEFAULT_PREFERENCES_WIRE, shortcuts };
}

const rowFor = (command: string): HTMLElement =>
  document.querySelector(`[data-testid="shortcut-row"][data-command="${command}"]`) as HTMLElement;

describe('ShortcutsEditor', () => {
  beforeEach(() => {
    installWirebenchApi();
    usePreferencesStore.setState({ preferences: DEFAULT_PREFERENCES_WIRE, loaded: true });
    registerShellCommands(() => undefined);
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('renders one row per command, with its default and current chord', () => {
    render(<ShortcutsEditor context={context} />);
    const row = within(rowFor('request.send'));

    expect(row.getByLabelText('Shortcut for Send Request').textContent).toBe('⌘⏎');
  });

  it('says so when a command has no binding', () => {
    render(<ShortcutsEditor context={context} />);

    expect(within(rowFor('project.close')).getByLabelText('Shortcut for Close Project').textContent).toBe('Unassigned');
  });

  it('records the next keystroke as the new binding and persists it', async () => {
    const update = vi.fn().mockResolvedValue({
      ok: true,
      value: { preferences: withShortcuts({ 'request.send': 'Mod+Shift+Enter' }) },
    });
    installWirebenchApi({ preferences: { update } });
    render(<ShortcutsEditor context={context} />);

    const chord = within(rowFor('request.send')).getByLabelText('Shortcut for Send Request');
    fireEvent.click(chord);
    expect(chord.textContent).toBe('Press a key…');
    fireEvent.keyDown(chord, { key: 'Enter', metaKey: true, shiftKey: true });

    await vi.waitFor(() => {
      expect(update).toHaveBeenCalledWith({ patch: { shortcuts: { 'request.send': 'Mod+Shift+Enter' } } });
    });
  });

  it('leaves recording on Escape without binding anything', () => {
    const update = vi.fn();
    installWirebenchApi({ preferences: { update } });
    render(<ShortcutsEditor context={context} />);

    const chord = within(rowFor('request.send')).getByLabelText('Shortcut for Send Request');
    fireEvent.click(chord);
    fireEvent.keyDown(chord, { key: 'Escape' });

    expect(chord.textContent).toBe('⌘⏎');
    expect(update).not.toHaveBeenCalled();
  });

  it('unbinds a command with Backspace', async () => {
    const update = vi
      .fn()
      .mockResolvedValue({ ok: true, value: { preferences: withShortcuts({ 'request.send': '' }) } });
    installWirebenchApi({ preferences: { update } });
    render(<ShortcutsEditor context={context} />);

    const chord = within(rowFor('request.send')).getByLabelText('Shortcut for Send Request');
    fireEvent.click(chord);
    fireEvent.keyDown(chord, { key: 'Backspace' });

    await vi.waitFor(() => {
      expect(update).toHaveBeenCalledWith({ patch: { shortcuts: { 'request.send': '' } } });
    });
  });

  it('refuses a bare key and says why, without persisting anything', () => {
    const update = vi.fn();
    installWirebenchApi({ preferences: { update } });
    render(<ShortcutsEditor context={context} />);

    const row = within(rowFor('request.send'));
    const chord = row.getByLabelText('Shortcut for Send Request');
    fireEvent.click(chord);
    fireEvent.keyDown(chord, { key: 'k' });

    expect(row.getByTestId('shortcut-refused').textContent).toContain('bare key');
    expect(update).not.toHaveBeenCalled();
  });

  it('accepts a chord carrying Alt', async () => {
    const update = vi
      .fn()
      .mockResolvedValue({ ok: true, value: { preferences: withShortcuts({ 'request.send': 'Alt+K' }) } });
    installWirebenchApi({ preferences: { update } });
    render(<ShortcutsEditor context={context} />);

    const chord = within(rowFor('request.send')).getByLabelText('Shortcut for Send Request');
    fireEvent.click(chord);
    fireEvent.keyDown(chord, { key: 'k', altKey: true });

    await vi.waitFor(() => {
      expect(update).toHaveBeenCalledWith({ patch: { shortcuts: { 'request.send': 'Alt+K' } } });
    });
    expect(screen.queryAllByTestId('shortcut-refused')).toEqual([]);
  });

  it('warns when two commands share a chord', () => {
    usePreferencesStore.setState({ preferences: withShortcuts({ 'request.validate': 'Mod+Enter' }), loaded: true });
    render(<ShortcutsEditor context={context} />);

    expect(within(rowFor('request.send')).getByTestId('shortcut-conflict').textContent).toContain('Validate Request');
    expect(within(rowFor('request.validate')).getByTestId('shortcut-conflict').textContent).toContain('Send Request');
  });

  it('shows no warning for the shipped keymap', () => {
    render(<ShortcutsEditor context={context} />);

    expect(screen.queryAllByTestId('shortcut-conflict')).toEqual([]);
  });

  it('enables Reset only on a customized row, and resets it to the default', async () => {
    const update = vi.fn().mockResolvedValue({ ok: true, value: { preferences: DEFAULT_PREFERENCES_WIRE } });
    usePreferencesStore.setState({ preferences: withShortcuts({ 'request.send': 'Mod+Shift+Enter' }), loaded: true });
    installWirebenchApi({ preferences: { update } });
    render(<ShortcutsEditor context={context} />);

    expect(
      within(rowFor('request.cancel')).getByLabelText<HTMLButtonElement>('Reset shortcut for Cancel Request').disabled,
    ).toBe(true);
    fireEvent.click(within(rowFor('request.send')).getByLabelText('Reset shortcut for Send Request'));

    await vi.waitFor(() => {
      expect(update).toHaveBeenCalledWith({ patch: { shortcuts: { 'request.send': 'Mod+Enter' } } });
    });
  });

  it('resets every binding through the shortcuts section reset', async () => {
    const reset = vi.fn().mockResolvedValue({ ok: true, value: { preferences: DEFAULT_PREFERENCES_WIRE } });
    installWirebenchApi({ preferences: { reset } });
    render(<ShortcutsEditor context={context} />);

    fireEvent.click(screen.getByTestId('shortcuts-reset-all'));

    await vi.waitFor(() => {
      expect(reset).toHaveBeenCalledWith({ section: 'shortcuts' });
    });
  });
});
