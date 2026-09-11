import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The Shortcuts section lists the registered commands, and registering them reaches the
// Monaco-backed editor commands — which jsdom cannot load.
vi.mock('../../src/renderer/editor/monaco.js', async () => await import('../mocks/monaco-runtime.js'));

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { PreferencesEditor } from '../../src/renderer/features/preferences/preferences-editor.js';
import { registerShellCommands } from '../../src/renderer/commands/register-shell-commands.js';
import { usePreferencesStore } from '../../src/renderer/state/preferences.js';
import { useUiStore } from '../../src/renderer/state/ui.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';
import { DEFAULT_PREFERENCES_WIRE } from '../../src/renderer/state/preferences-defaults.js';
import type { PreferencesPatchWire, PreferencesWire } from '../../src/shared/wire-types.js';

const DEFAULTS = DEFAULT_PREFERENCES_WIRE;

/** Replies with the defaults merged with `patch`, the way main's deep merge would. */
function stubUpdate() {
  return vi.fn((request: { patch: PreferencesPatchWire }) => {
    const preferences: PreferencesWire = { ...DEFAULTS };
    for (const [section, values] of Object.entries(request.patch as Record<string, Record<string, unknown>>)) {
      (preferences as unknown as Record<string, unknown>)[section] = {
        ...(DEFAULTS as unknown as Record<string, object>)[section],
        ...values,
      };
    }
    return Promise.resolve({ ok: true as const, value: { preferences } });
  });
}

describe('PreferencesEditor', () => {
  beforeEach(() => {
    installWirebenchApi();
    usePreferencesStore.setState({ preferences: DEFAULTS, loaded: true });
    registerShellCommands(() => undefined);
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('lists every section', () => {
    render(<PreferencesEditor />);
    for (const label of ['HTTP', 'Proxy', 'SSL', 'WSDL', 'WS-I', 'Editor', 'UI', 'Shortcuts']) {
      expect(screen.getByRole('button', { name: label })).toBeTruthy();
    }
  });

  it('opens on HTTP and switches sections on click', () => {
    render(<PreferencesEditor />);
    expect(screen.getByLabelText('User-Agent')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'WSDL' }));
    expect(screen.getByLabelText('Sample values')).toBeTruthy();
  });

  it('sends one field as a patch', async () => {
    const update = stubUpdate();
    installWirebenchApi({ preferences: { update } });
    render(<PreferencesEditor initialSection="editor" />);

    const tabSize = screen.getByLabelText('Tab size');
    fireEvent.change(tabSize, { target: { value: '2' } });
    fireEvent.keyDown(tabSize, { key: 'Enter' });

    await vi.waitFor(() => {
      expect(update).toHaveBeenCalledWith({ patch: { editor: { tabSize: 2 } } });
    });
  });

  it('pushes a theme change into the ui store, which is what the shell renders from', async () => {
    installWirebenchApi({ preferences: { update: stubUpdate() } });
    render(<PreferencesEditor initialSection="ui" />);

    fireEvent.change(screen.getByLabelText('Theme'), { target: { value: 'light' } });

    await vi.waitFor(() => {
      expect(useUiStore.getState().theme).toBe('light');
    });
  });

  it('resets the section that is showing', async () => {
    const reset = vi.fn().mockResolvedValue({ ok: true, value: { preferences: DEFAULTS } });
    installWirebenchApi({ preferences: { reset } });
    render(<PreferencesEditor initialSection="editor" />);

    fireEvent.click(screen.getByRole('button', { name: 'Reset section' }));

    await vi.waitFor(() => {
      expect(reset).toHaveBeenCalledWith({ section: 'editor' });
    });
  });

  it('says the proxy applies to every send, and how excludes behave', () => {
    render(<PreferencesEditor initialSection="proxy" />);
    expect(screen.getByText(/Applied to every send/)).toBeTruthy();
    expect(screen.getByLabelText('Excludes')).toBeTruthy();
  });

  it('points the user at the per-endpoint opt-in instead of a global trust-all', () => {
    render(<PreferencesEditor initialSection="ssl" />);
    expect(screen.getByTitle(/Trust invalid certificates/)).toBeTruthy();
    expect(screen.getByLabelText('CA bundle')).toBeTruthy();
  });

  it('never lets trust-all be turned on', () => {
    render(<PreferencesEditor initialSection="ssl" />);
    const trustAll = screen.getByLabelText<HTMLInputElement>('Trust all certificates');
    expect(trustAll.checked).toBe(false);
    expect(trustAll.disabled).toBe(true);
  });

  it('shows the rebindable shortcuts table', () => {
    render(<PreferencesEditor initialSection="shortcuts" />);
    expect(screen.getByTestId('shortcuts-table')).toBeTruthy();
    expect(screen.getByText('Show All Commands')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Shortcut for Send Request' })).toBeTruthy();
  });
});
