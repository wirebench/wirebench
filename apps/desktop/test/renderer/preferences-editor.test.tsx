import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The Shortcuts section lists the registered commands, and registering them reaches the
// Monaco-backed editor commands — which jsdom cannot load.
vi.mock('../../src/renderer/editor/monaco.js', async () => await import('../mocks/monaco-runtime.js'));

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { PreferencesEditor } from '../../src/renderer/features/preferences/preferences-editor.js';
import { registerShellCommands } from '../../src/renderer/commands/register-shell-commands.js';
import { usePreferencesStore } from '../../src/renderer/state/preferences.js';
import { useUiStore } from '../../src/renderer/state/ui.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';
import { DEFAULT_PREFERENCES_WIRE } from '../../src/renderer/state/preferences-defaults.js';
import type { PreferencesPatchWire, PreferencesWire } from '../../src/shared/wire-base.js';

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
    const nav = screen.getByRole('navigation', { name: 'Settings sections' });
    for (const group of ['General', 'Requests', 'Network', 'Workspace', 'Account']) {
      expect(within(nav).getByRole('heading', { name: group })).toBeTruthy();
    }
    for (const label of [
      'Appearance',
      'Behaviour',
      'Keyboard shortcuts',
      'Updates',
      'HTTP',
      'REST',
      'WSDL',
      'WS-I',
      'Proxy',
      'SSL / TLS',
      'Git',
      'Mock services',
      'Terminal',
      'Secrets',
      'Accounts',
      'Devices & tokens',
    ]) {
      expect(within(nav).getByRole('button', { name: label })).toBeTruthy();
    }
  });

  it('opens on Appearance and switches sections on click', () => {
    render(<PreferencesEditor />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Appearance');
    expect(screen.getByText('Theme, editor fonts and the default request layout.')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'WSDL' }));
    expect(screen.getByLabelText('Sample values')).toBeTruthy();
  });

  it('sends one field as a patch', async () => {
    const update = stubUpdate();
    installWirebenchApi({ preferences: { update } });
    render(<PreferencesEditor initialSection="appearance" />);

    const tabSize = screen.getByLabelText('Tab size');
    fireEvent.change(tabSize, { target: { value: '2' } });
    fireEvent.keyDown(tabSize, { key: 'Enter' });

    await vi.waitFor(() => {
      expect(update).toHaveBeenCalledWith({ patch: { editor: { tabSize: 2 } } });
    });
  });

  it('puts a field back to the saved value when main refuses the change', async () => {
    const update = vi.fn().mockResolvedValue({
      ok: false,
      error: { code: 'preference-locked', message: 'Locked by the managed-preferences policy: editor.tabSize' },
    });
    installWirebenchApi({ preferences: { update } });
    usePreferencesStore.getState().applyPreferences(DEFAULTS);
    render(<PreferencesEditor initialSection="appearance" />);

    const tabSize = screen.getByLabelText<HTMLInputElement>('Tab size');
    fireEvent.change(tabSize, { target: { value: '8' } });
    fireEvent.keyDown(tabSize, { key: 'Enter' });
    await vi.waitFor(() => {
      expect(tabSize.value).toBe(String(DEFAULTS.editor.tabSize));
    });
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('sets the secret source cache lifetime from the Secrets section', async () => {
    const update = stubUpdate();
    installWirebenchApi({ preferences: { update } });
    render(<PreferencesEditor />);
    fireEvent.click(screen.getByRole('button', { name: 'Secrets' }));

    const field = screen.getByLabelText('Secret source cache');
    fireEvent.change(field, { target: { value: '60' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    await vi.waitFor(() => {
      expect(update).toHaveBeenCalledWith({ patch: { secrets: { sourceCacheSeconds: 60 } } });
    });
  });

  it('sets the terminal paste and copy preferences from the Terminal section', async () => {
    const update = stubUpdate();
    installWirebenchApi({ preferences: { update } });
    render(<PreferencesEditor />);
    fireEvent.click(screen.getByRole('button', { name: 'Terminal' }));

    const confirm = screen.getByRole('switch', { name: 'Confirm multi-line paste' });
    expect(confirm.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(confirm);
    await vi.waitFor(() => {
      expect(update).toHaveBeenCalledWith({ patch: { terminal: { confirmMultilinePaste: false } } });
    });

    const copy = screen.getByRole('switch', { name: 'Copy on select' });
    expect(copy.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(copy);
    await vi.waitFor(() => {
      expect(update).toHaveBeenCalledWith({ patch: { terminal: { copyOnSelect: true } } });
    });
  });

  it('sets auto-reconnect and its attempt limit from the Terminal section, refusing a limit out of range', async () => {
    const update = stubUpdate();
    installWirebenchApi({ preferences: { update } });
    render(<PreferencesEditor />);
    fireEvent.click(screen.getByRole('button', { name: 'Terminal' }));

    const attempts = screen.getByLabelText<HTMLInputElement>('Reconnect attempts');
    expect(attempts.value).toBe('10');
    fireEvent.change(attempts, { target: { value: '101' } });
    fireEvent.keyDown(attempts, { key: 'Enter' });
    expect(screen.getByText('Enter a whole number from 1 to 100')).toBeTruthy();
    expect(update).not.toHaveBeenCalled();
    fireEvent.change(attempts, { target: { value: '25' } });
    fireEvent.keyDown(attempts, { key: 'Enter' });
    await vi.waitFor(() => {
      expect(update).toHaveBeenCalledWith({ patch: { terminal: { reconnectAttempts: 25 } } });
    });

    const reconnect = screen.getByRole('switch', { name: 'Reconnect dropped sessions' });
    expect(reconnect.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(reconnect);
    await vi.waitFor(() => {
      expect(update).toHaveBeenCalledWith({ patch: { terminal: { autoReconnect: false } } });
    });
  });

  it('turns snippet suggestions off from the Terminal section', async () => {
    const update = stubUpdate();
    installWirebenchApi({ preferences: { update } });
    render(<PreferencesEditor />);
    fireEvent.click(screen.getByRole('button', { name: 'Terminal' }));

    const suggest = screen.getByRole('switch', { name: 'Suggest snippets' });
    expect(suggest.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(suggest);
    await vi.waitFor(() => {
      expect(update).toHaveBeenCalledWith({ patch: { terminal: { snippetSuggestions: false } } });
    });
  });

  it('sets the terminal font size, line height and colour scheme from the Terminal section', async () => {
    const update = stubUpdate();
    installWirebenchApi({ preferences: { update } });
    render(<PreferencesEditor />);
    fireEvent.click(screen.getByRole('button', { name: 'Terminal' }));

    const size = screen.getByLabelText<HTMLInputElement>('Font size');
    expect(size.value).toBe('13');
    fireEvent.change(size, { target: { value: '16' } });
    fireEvent.keyDown(size, { key: 'Enter' });
    await vi.waitFor(() => {
      expect(update).toHaveBeenCalledWith({ patch: { terminal: { fontSize: 16 } } });
    });

    const lineHeight = screen.getByLabelText<HTMLInputElement>('Line height');
    fireEvent.change(lineHeight, { target: { value: '1.4' } });
    fireEvent.keyDown(lineHeight, { key: 'Enter' });
    await vi.waitFor(() => {
      expect(update).toHaveBeenCalledWith({ patch: { terminal: { lineHeight: 1.4 } } });
    });

    const scheme = screen.getByLabelText<HTMLSelectElement>('Colour scheme');
    expect(scheme.value).toBe('app');
    expect([...scheme.options].map((o) => o.textContent)).toEqual(
      expect.arrayContaining(['Follow app theme', 'Red background', 'Solarized Dark']),
    );
    fireEvent.change(scheme, { target: { value: 'nord' } });
    await vi.waitFor(() => {
      expect(update).toHaveBeenCalledWith({ patch: { terminal: { colorScheme: 'nord' } } });
    });
  });

  describe('the terminal font family', () => {
    afterEach(() => {
      delete (window as { queryLocalFonts?: unknown }).queryLocalFonts;
    });

    it('is picked from the installed monospace fonts', async () => {
      (window as { queryLocalFonts?: unknown }).queryLocalFonts = vi
        .fn()
        .mockResolvedValue([{ family: 'Fira Code' }, { family: 'Fira Code' }, { family: 'Helvetica' }]);
      // A proportional family measures a row of i narrower than a row of M; a monospaced one does not.
      vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
        font: '',
        measureText(this: { font: string }, text: string) {
          return { width: this.font.includes('Helvetica') && text.startsWith('i') ? 10 : 30 };
        },
      } as unknown as CanvasRenderingContext2D);
      const update = stubUpdate();
      installWirebenchApi({ preferences: { update } });
      render(<PreferencesEditor />);
      fireEvent.click(screen.getByRole('button', { name: 'Terminal' }));

      const family = await screen.findByRole<HTMLSelectElement>('combobox', { name: 'Font family' });
      await vi.waitFor(() => {
        expect([...family.options].map((o) => o.value)).toEqual(['', 'Fira Code']);
      });
      fireEvent.change(family, { target: { value: 'Fira Code' } });
      await vi.waitFor(() => {
        expect(update).toHaveBeenCalledWith({ patch: { terminal: { fontFamily: 'Fira Code' } } });
      });
    });

    it('is typed when the installed fonts cannot be listed', async () => {
      const update = stubUpdate();
      installWirebenchApi({ preferences: { update } });
      render(<PreferencesEditor />);
      fireEvent.click(screen.getByRole('button', { name: 'Terminal' }));

      const family = await screen.findByRole<HTMLInputElement>('textbox', { name: 'Font family' });
      fireEvent.change(family, { target: { value: 'Iosevka' } });
      fireEvent.keyDown(family, { key: 'Enter' });
      await vi.waitFor(() => {
        expect(update).toHaveBeenCalledWith({ patch: { terminal: { fontFamily: 'Iosevka' } } });
      });
    });
  });

  it('refuses a secret source cache lifetime above 3600 seconds, saying why, until it is fixed', async () => {
    const update = stubUpdate();
    installWirebenchApi({ preferences: { update } });
    render(<PreferencesEditor />);
    fireEvent.click(screen.getByRole('button', { name: 'Secrets' }));

    const field = screen.getByLabelText<HTMLInputElement>('Secret source cache');
    fireEvent.change(field, { target: { value: '3601' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    // The draft stays, marked invalid with the rule, and nothing is sent.
    expect(field.value).toBe('3601');
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByText('Enter a whole number from 0 to 3600')).toBeTruthy();
    expect(update).not.toHaveBeenCalled();

    fireEvent.change(field, { target: { value: '3600' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    await vi.waitFor(() => {
      expect(update).toHaveBeenCalledWith({ patch: { secrets: { sourceCacheSeconds: 3600 } } });
    });
  });

  it('sets HTTP Log rows kept, refusing a value outside 100–5000', async () => {
    const update = stubUpdate();
    installWirebenchApi({ preferences: { update } });
    render(<PreferencesEditor initialSection="behaviour" />);

    const field = screen.getByLabelText('HTTP Log rows kept');
    fireEvent.change(field, { target: { value: '1000' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    await vi.waitFor(() => {
      expect(update).toHaveBeenCalledWith({ patch: { ui: { logSize: 1000 } } });
    });

    fireEvent.change(field, { target: { value: '99999' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(screen.getByText('Enter a whole number from 100 to 5000')).toBeTruthy();
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('pushes a theme change into the ui store, which is what the shell renders from', async () => {
    installWirebenchApi({ preferences: { update: stubUpdate() } });
    render(<PreferencesEditor initialSection="appearance" />);

    fireEvent.click(screen.getByRole('radio', { name: 'Light' }));

    await vi.waitFor(() => {
      expect(useUiStore.getState().theme).toBe('light');
    });
  });

  it('resets a stored section from the section menu', async () => {
    const reset = vi.fn().mockResolvedValue({ ok: true, value: { preferences: DEFAULTS } });
    installWirebenchApi({ preferences: { reset } });
    render(<PreferencesEditor initialSection="http" />);

    fireEvent.keyDown(screen.getByRole('button', { name: 'More actions for HTTP' }), { key: 'Enter' });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Reset HTTP to defaults' }));

    await vi.waitFor(() => {
      expect(reset).toHaveBeenCalledWith({ section: 'http' });
    });
  });

  it('resets Appearance field by field, leaving Behaviour alone', async () => {
    const update = stubUpdate();
    const reset = vi.fn();
    installWirebenchApi({ preferences: { update, reset } });
    usePreferencesStore.setState({
      preferences: {
        ...DEFAULTS,
        editor: { ...DEFAULTS.editor, wordWrap: true, autosave: true },
        ui: { ...DEFAULTS.ui, theme: 'light' },
      },
    });
    render(<PreferencesEditor initialSection="appearance" />);

    fireEvent.keyDown(screen.getByRole('button', { name: 'More actions for Appearance' }), { key: 'Enter' });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Reset Appearance to defaults' }));

    await vi.waitFor(() => {
      expect(update).toHaveBeenCalledTimes(1);
    });
    const patch = update.mock.calls[0]![0].patch as { editor: Record<string, unknown>; ui: Record<string, unknown> };
    expect(patch.editor['wordWrap']).toBe(false);
    expect(patch.ui['theme']).toBe('dark');
    expect(patch.ui['defaultLayout']).toEqual(DEFAULTS.ui.defaultLayout);
    expect('autosave' in patch.editor).toBe(false);
    expect('confirmOnDelete' in patch.ui).toBe(false);
    expect(reset).not.toHaveBeenCalled();
  });

  it('says the proxy applies to every send, and how excludes behave', () => {
    render(<PreferencesEditor initialSection="proxy" />);
    expect(screen.getByText(/Applied to every send/)).toBeTruthy();
    expect(screen.getByLabelText('Excludes')).toBeTruthy();
  });

  it('points the user at the per-endpoint opt-in instead of a global trust-all', () => {
    render(<PreferencesEditor initialSection="ssl" />);
    expect(screen.getByText(/Trust invalid certificates/)).toBeTruthy();
    expect(screen.getByLabelText('CA bundle')).toBeTruthy();
  });

  it('never lets trust-all be turned on', () => {
    render(<PreferencesEditor initialSection="ssl" />);
    const trustAll = screen.getByRole('switch', { name: 'Trust all certificates' });
    expect(trustAll.getAttribute('aria-checked')).toBe('false');
    expect(trustAll.hasAttribute('disabled')).toBe(true);
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

  it('takes a fractional MiB threshold and refuses zero', () => {
    const update = openRest();
    const field = screen.getByTestId<HTMLInputElement>('rest-pref-pretty-max');
    fireEvent.change(field, { target: { value: '0.5' } });
    fireEvent.blur(field);
    expect(update).toHaveBeenCalledWith({ patch: { rest: { prettyPrintMaxBytes: 512 * 1024 } } });

    fireEvent.change(field, { target: { value: '0' } });
    fireEvent.blur(field);
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByText('Enter a number from 0.01 to 1024')).toBeTruthy();
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('shows units beside the field rather than in the label', () => {
    openRest();
    const field = screen.getByLabelText('Pretty-print up to');
    expect(field.closest('[data-setting-row]')?.querySelector('[data-testid="setting-unit"]')?.textContent).toBe('MiB');
  });

  it('refuses control characters in the default Accept header and trims it', () => {
    const update = openRest();
    const accept = screen.getByTestId('rest-pref-default-accept');
    fireEvent.change(accept, { target: { value: 'application/json\u0007' } });
    fireEvent.blur(accept);
    expect(screen.getByText('Control characters and line breaks are not allowed in a header value')).toBeTruthy();
    expect(update).not.toHaveBeenCalled();

    fireEvent.change(accept, { target: { value: '  application/xml  ' } });
    fireEvent.blur(accept);
    expect(update).toHaveBeenCalledWith({ patch: { rest: { defaultAccept: 'application/xml' } } });
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

  it('treats an empty OAuth2 port as "take a free one" and refuses one below 1024', () => {
    const update = openRest();

    const port = screen.getByTestId('rest-pref-oauth2-port');
    fireEvent.change(port, { target: { value: '8123' } });
    fireEvent.blur(port);
    expect(update).toHaveBeenCalledWith({ patch: { rest: { oauth2CallbackPort: 8123 } } });

    fireEvent.change(port, { target: { value: '' } });
    fireEvent.blur(port);
    // `null`, not `undefined`: main clears a key only on `null`.
    expect(update).toHaveBeenLastCalledWith({ patch: { rest: { oauth2CallbackPort: null } } });

    fireEvent.change(port, { target: { value: '80' } });
    fireEvent.blur(port);
    expect(screen.getByText('Enter a whole number from 1024 to 65535')).toBeTruthy();
    expect(update).toHaveBeenCalledTimes(2);
  });

  it('says the loopback listener is the only thing the port changes', () => {
    openRest();
    expect(screen.getByText(/The loopback listener only ever binds 127\.0\.0\.1/)).toBeTruthy();
  });
});

describe('PreferencesEditor — Proxy', () => {
  beforeEach(() => {
    installWirebenchApi();
  });
  afterEach(() => {
    cleanup();
  });

  function openProxy(mode: 'none' | 'system' | 'manual', update = stubUpdate()): ReturnType<typeof stubUpdate> {
    usePreferencesStore.setState({
      preferences: { ...DEFAULTS, proxy: { mode, host: 'proxy.internal', port: 3128, excludes: [] } },
      loaded: true,
    });
    installWirebenchApi({ preferences: { update } });
    render(<PreferencesEditor initialSection="proxy" />);
    return update;
  }

  it.each(['none', 'system'] as const)(
    'makes every manual-only field read-only in %s mode, but not Excludes',
    (mode) => {
      openProxy(mode);
      for (const testId of ['proxy-host', 'proxy-port', 'proxy-username']) {
        expect(screen.getByTestId(testId).hasAttribute('readonly'), testId).toBe(true);
      }
      expect(screen.getByTestId('proxy-excludes').hasAttribute('readonly')).toBe(false);
    },
  );

  it('refuses a port that is not a whole number from 1 to 65535', () => {
    const update = openProxy('manual');
    const port = screen.getByTestId<HTMLInputElement>('proxy-port');
    fireEvent.change(port, { target: { value: '99999' } });
    fireEvent.blur(port);
    expect(screen.getByText('Enter a whole number from 1 to 65535')).toBeTruthy();
    // A letter or a dot cannot be typed at all.
    fireEvent.change(port, { target: { value: '80.5' } });
    expect(port.value).toBe('99999');
    expect(update).not.toHaveBeenCalled();

    fireEvent.change(port, { target: { value: '' } });
    fireEvent.blur(port);
    expect(update).toHaveBeenCalledWith({ patch: { proxy: { port: null } } });
  });

  it.each(['http://proxy.internal', 'proxy.internal:3128', 'proxy/internal', 'proxy internal'])(
    'refuses the host %s',
    (host) => {
      const update = openProxy('manual');
      const field = screen.getByTestId('proxy-host');
      fireEvent.change(field, { target: { value: host } });
      fireEvent.blur(field);
      expect(screen.getByText('Host name or IP only — set the port below')).toBeTruthy();
      expect(field.getAttribute('aria-invalid')).toBe('true');
      expect(update).not.toHaveBeenCalled();
    },
  );

  it.each(['10.0.0.1', 'proxy-2.corp.example', '::1', '[fe80::1]'])('accepts the host %s', (host) => {
    const update = openProxy('manual');
    const field = screen.getByTestId('proxy-host');
    fireEvent.change(field, { target: { value: ` ${host} ` } });
    fireEvent.blur(field);
    expect(update).toHaveBeenCalledWith({ patch: { proxy: { host } } });
  });
});

describe('PreferencesEditor under a managed-preferences policy', () => {
  const POLICY = {
    path: '/etc/wirebench/policy.yaml',
    locked: ['proxy.mode', 'ssl.caBundlePath', 'updates.checkOnLaunch'],
    ignored: ['editor'],
  };

  beforeEach(() => {
    installWirebenchApi();
    usePreferencesStore.setState({ preferences: DEFAULTS, loaded: true, policy: POLICY });
    registerShellCommands(() => undefined);
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    usePreferencesStore.setState({ policy: undefined });
  });

  it('names the policy file and what it could not lock', () => {
    render(<PreferencesEditor />);
    const note = screen.getByTestId('preferences-policy');
    expect(note.textContent).toContain('/etc/wirebench/policy.yaml');
    expect(note.textContent).toContain('editor');
  });

  it('shows a locked proxy mode as such and leaves the rest editable', () => {
    render(<PreferencesEditor initialSection="proxy" />);
    const mode = screen.getByTestId('proxy-mode');
    expect(mode.getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByTestId('proxy-mode-manual').hasAttribute('disabled')).toBe(true);
    expect(mode.closest('[data-locked]')?.textContent).toContain('Managed');
    const port = screen.getByTestId('proxy-port');
    expect(port.hasAttribute('disabled')).toBe(false);
    expect(port.closest('[data-locked]')).toBeNull();
  });

  it('locks the CA bundle pickers', () => {
    usePreferencesStore.setState({
      preferences: { ...DEFAULTS, ssl: { ...DEFAULTS.ssl, caBundlePath: '/etc/ssl/corp.pem' } },
    });
    render(<PreferencesEditor initialSection="ssl" />);
    expect(screen.getByTestId('ssl-ca-bundle-browse').hasAttribute('disabled')).toBe(true);
    expect(screen.queryByTestId('ssl-ca-bundle-clear')).toBeNull();
    expect(screen.getByTestId('ssl-ca-bundle').closest('[data-locked]')).not.toBeNull();
  });

  it('locks update checks', () => {
    render(<PreferencesEditor initialSection="updates" />);
    expect(screen.getByLabelText('Check for updates on launch').hasAttribute('disabled')).toBe(true);
  });

  it('reports a policy that could not be applied', () => {
    usePreferencesStore.setState({
      policy: { path: POLICY.path, locked: [], ignored: [], error: 'The policy file is not valid YAML' },
    });
    render(<PreferencesEditor />);
    expect(screen.queryByTestId('preferences-policy')).toBeNull();
    expect(screen.getByRole('alert').textContent).toContain('not valid YAML');
  });
});

describe('PreferencesEditor — Appearance and Behaviour', () => {
  beforeEach(() => {
    installWirebenchApi();
    usePreferencesStore.setState({ preferences: DEFAULTS, loaded: true });
  });
  afterEach(() => {
    cleanup();
  });

  it('puts the theme, editor and default layout under Appearance', () => {
    render(<PreferencesEditor initialSection="appearance" />);
    for (const label of ['Font family', 'Font size', 'Tab size', 'Line numbers', 'Word wrap']) {
      expect(screen.getByLabelText(label)).toBeTruthy();
    }
    expect(screen.getByRole('radiogroup', { name: 'Theme' })).toBeTruthy();
    expect(screen.getByRole('radiogroup', { name: 'Orientation' })).toBeTruthy();
    expect(screen.getByRole('radiogroup', { name: 'Mode' })).toBeTruthy();
    for (const label of ['Validate before sending', 'Autosave projects', 'History entries kept']) {
      expect(screen.queryByLabelText(label)).toBeNull();
    }
  });

  it('puts what happens around sends, saves and history under Behaviour', () => {
    render(<PreferencesEditor initialSection="behaviour" />);
    for (const label of [
      'Validate before sending',
      'Format responses',
      'Autosave projects',
      'Confirm before deleting',
      'History entries kept',
      'HTTP Log rows kept',
    ]) {
      expect(screen.getByLabelText(label)).toBeTruthy();
    }
    expect(screen.queryByRole('radiogroup', { name: 'Theme' })).toBeNull();
    expect(screen.queryByLabelText('Tab size')).toBeNull();
  });
});

describe('PreferencesEditor — search', () => {
  beforeEach(() => {
    installWirebenchApi();
    usePreferencesStore.setState({ preferences: DEFAULTS, loaded: true });
    registerShellCommands(() => undefined);
  });
  afterEach(() => {
    cleanup();
  });

  function search(text: string): void {
    fireEvent.change(screen.getByLabelText('Search settings'), { target: { value: text } });
  }

  it('finds matching settings across sections, each with where it lives', () => {
    render(<PreferencesEditor />);
    search('timeout');

    const results = screen.getByTestId('settings-search-results');
    expect(within(results).getByLabelText('Socket timeout')).toBeTruthy();
    expect(
      within(results)
        .getAllByTestId('setting-crumb')
        .map((crumb) => crumb.textContent),
    ).toContain('Requests › HTTP');
    // Everything else is filtered out, and no section is marked current while searching.
    expect(within(results).queryByLabelText('User-Agent')).toBeNull();
    expect(screen.queryByRole('button', { current: 'page' })).toBeNull();
    expect(screen.getByTestId('settings-search-summary').textContent).toMatch(/^\d+ settings? match “timeout”$/);
  });

  it('matches hints, group titles and section names too', () => {
    render(<PreferencesEditor />);
    search('keychain');
    expect(screen.getByText('Network › Proxy')).toBeTruthy();

    search('generated requests');
    expect(screen.getByLabelText('Sample values')).toBeTruthy();

    search('ssl / tls');
    expect(screen.getByLabelText('Expiry warning')).toBeTruthy();
  });

  it('leaves the matching controls fully working', async () => {
    const update = stubUpdate();
    installWirebenchApi({ preferences: { update } });
    render(<PreferencesEditor />);
    search('copy on select');

    fireEvent.click(screen.getByRole('switch', { name: 'Copy on select' }));
    await vi.waitFor(() => {
      expect(update).toHaveBeenCalledWith({ patch: { terminal: { copyOnSelect: true } } });
    });
  });

  it('finds sections that are not lists of settings by name, and opens them', () => {
    render(<PreferencesEditor />);
    search('shortcuts');
    fireEvent.click(screen.getByTestId('settings-search-open-shortcuts'));
    expect(screen.getByTestId('shortcuts-table')).toBeTruthy();
    expect(screen.getByLabelText<HTMLInputElement>('Search settings').value).toBe('');
  });

  it('says so when nothing matches', () => {
    render(<PreferencesEditor />);
    search('zzz-no-such-setting');
    expect(screen.getByTestId('settings-search-empty')).toBeTruthy();
    expect(screen.getByTestId('settings-search-summary').textContent).toContain('0 settings match');
  });
});

describe('PreferencesEditor — changed settings', () => {
  beforeEach(() => {
    installWirebenchApi();
    registerShellCommands(() => undefined);
  });
  afterEach(() => {
    cleanup();
  });

  it('marks a changed row and resets just that field', async () => {
    const update = stubUpdate();
    installWirebenchApi({ preferences: { update } });
    usePreferencesStore.setState({
      preferences: { ...DEFAULTS, http: { ...DEFAULTS.http, maxConnections: 7, offerH2: false } },
      loaded: true,
    });
    render(<PreferencesEditor initialSection="http" />);

    expect(screen.getAllByTestId('setting-modified')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Reset Max connections to default' }));
    await vi.waitFor(() => {
      expect(update).toHaveBeenCalledWith({ patch: { http: { maxConnections: DEFAULTS.http.maxConnections } } });
    });
  });

  it('resets a nested field together with its siblings', async () => {
    const update = stubUpdate();
    installWirebenchApi({ preferences: { update } });
    usePreferencesStore.setState({
      preferences: { ...DEFAULTS, ui: { ...DEFAULTS.ui, defaultLayout: { orientation: 'stacked', mode: 'tabs' } } },
      loaded: true,
    });
    render(<PreferencesEditor initialSection="appearance" />);

    fireEvent.click(screen.getByRole('button', { name: 'Reset Orientation to default' }));
    await vi.waitFor(() => {
      expect(update).toHaveBeenCalledWith({
        patch: { ui: { defaultLayout: { orientation: 'side-by-side', mode: 'tabs' } } },
      });
    });
  });

  it('puts a dot on sections with changes, and only those', () => {
    usePreferencesStore.setState({
      preferences: {
        ...DEFAULTS,
        terminal: { ...DEFAULTS.terminal, copyOnSelect: true },
        editor: { ...DEFAULTS.editor, autosave: true },
      },
      loaded: true,
    });
    render(<PreferencesEditor />);

    const modified = screen
      .getAllByRole('button')
      .filter((button) => button.getAttribute('data-modified') === 'true')
      .map((button) => button.textContent);
    expect(modified.sort()).toEqual(['Behaviour', 'Terminal']);
    expect(screen.getAllByTestId('settings-nav-modified')).toHaveLength(2);
  });

  it('offers no per-row reset on a field at its default', () => {
    usePreferencesStore.setState({ preferences: DEFAULTS, loaded: true });
    render(<PreferencesEditor initialSection="http" />);
    expect(screen.queryByTestId('setting-modified')).toBeNull();
    expect(screen.queryByTestId('setting-reset')).toBeNull();
  });
});
