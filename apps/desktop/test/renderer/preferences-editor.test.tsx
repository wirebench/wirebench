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
    for (const label of ['HTTP', 'Proxy', 'SSL', 'REST', 'Git', 'WSDL', 'WS-I', 'Editor', 'UI', 'Shortcuts']) {
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

  it('sets HTTP Log rows kept, clamped to 100–5000', async () => {
    const update = stubUpdate();
    installWirebenchApi({ preferences: { update } });
    render(<PreferencesEditor initialSection="ui" />);

    const field = screen.getByLabelText('HTTP Log rows kept');
    fireEvent.change(field, { target: { value: '1000' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    await vi.waitFor(() => {
      expect(update).toHaveBeenCalledWith({ patch: { ui: { logSize: 1000 } } });
    });

    fireEvent.change(field, { target: { value: '99999' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    await vi.waitFor(() => {
      expect(update).toHaveBeenCalledWith({ patch: { ui: { logSize: 5000 } } });
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

/**
 * The REST section. Every value is what a request *inherits*, so the tests pin the two conversions
 * that could silently mislead: the pretty-print threshold is entered in MiB and stored in bytes, and
 * an empty OAuth2 port means "take a free one", not port zero.
 */
describe('PreferencesEditor — REST', () => {
  beforeEach(() => {
    installWirebenchApi();
    usePreferencesStore.setState({ preferences: DEFAULTS, loaded: true });
  });

  afterEach(() => {
    cleanup();
  });

  function openRest(update = stubUpdate()): ReturnType<typeof stubUpdate> {
    installWirebenchApi({ preferences: { update } });
    render(<PreferencesEditor initialSection="rest" />);
    return update;
  }

  it('shows the defaults a request inherits', () => {
    openRest();

    expect(screen.getByTestId<HTMLInputElement>('rest-pref-max-redirects').value).toBe('5');
    expect(screen.getByTestId<HTMLInputElement>('rest-pref-pretty-max').value).toBe('5');
    expect(screen.getByTestId<HTMLInputElement>('rest-pref-default-accept').value).toBe('');
  });

  it('stores the pretty-print threshold in bytes, entered in MiB', () => {
    const update = openRest();

    const field = screen.getByTestId('rest-pref-pretty-max');
    fireEvent.change(field, { target: { value: '2' } });
    fireEvent.blur(field);

    expect(update).toHaveBeenCalledWith({ patch: { rest: { prettyPrintMaxBytes: 2 * 1024 * 1024 } } });
  });

  it('sends one field per edit', () => {
    const update = openRest();

    fireEvent.click(screen.getByLabelText('Follow redirects'));
    expect(update).toHaveBeenCalledWith({ patch: { rest: { followRedirects: false } } });

    const accept = screen.getByTestId('rest-pref-default-accept');
    fireEvent.change(accept, { target: { value: 'application/json' } });
    fireEvent.blur(accept);
    expect(update).toHaveBeenLastCalledWith({ patch: { rest: { defaultAccept: 'application/json' } } });
  });

  it('treats an empty or zero OAuth2 port as "take a free one"', () => {
    const update = openRest();

    const port = screen.getByTestId('rest-pref-oauth2-port');
    fireEvent.change(port, { target: { value: '8123' } });
    fireEvent.blur(port);
    expect(update).toHaveBeenCalledWith({ patch: { rest: { oauth2CallbackPort: 8123 } } });

    fireEvent.change(port, { target: { value: '' } });
    fireEvent.blur(port);
    expect(update).toHaveBeenLastCalledWith({ patch: { rest: { oauth2CallbackPort: undefined } } });
  });

  it('says the loopback listener is the only thing the port changes', () => {
    openRest();
    expect(screen.getByText(/127\.0\.0\.1/)).toBeTruthy();
  });
});
