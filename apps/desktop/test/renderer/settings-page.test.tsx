import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The Shortcuts section lists the registered commands, and registering them reaches the
// Monaco-backed editor commands — which jsdom cannot load.
vi.mock('../../src/renderer/editor/monaco.js', async () => await import('../mocks/monaco-runtime.js'));

import type { ReactElement } from 'react';
import * as Tooltip from '@radix-ui/react-tooltip';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ActivityBar } from '../../src/renderer/shell/activity-bar.js';
import { SettingsPage } from '../../src/renderer/features/preferences/settings-page.js';
import { usePreferencesStore } from '../../src/renderer/state/preferences.js';
import { DEFAULT_PREFERENCES_WIRE } from '../../src/renderer/state/preferences-defaults.js';
import { useUiStore } from '../../src/renderer/state/ui.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';

/** The shell supplies the tooltip provider that `IconButton` needs; a bare render does not. */
function renderInShell(ui: ReactElement) {
  return render(<Tooltip.Provider>{ui}</Tooltip.Provider>);
}

function currentSection(editor: HTMLElement): string | null | undefined {
  return editor.querySelector('[aria-current="page"]')?.textContent;
}

beforeEach(() => {
  installWirebenchApi();
  usePreferencesStore.setState({ preferences: DEFAULT_PREFERENCES_WIRE, loaded: true });
});

afterEach(() => {
  cleanup();
  useUiStore.setState({ preferences: { open: false, section: undefined } });
});

describe('Settings as a page', () => {
  it('opens from the activity bar without touching the sidebar', async () => {
    const before = useUiStore.getState().sidebar.view;
    renderInShell(<ActivityBar platform="mac" />);

    fireEvent.click(screen.getByRole('button', { name: /Settings/ }));

    await waitFor(() => {
      expect(useUiStore.getState().preferences.open).toBe(true);
    });
    expect(useUiStore.getState().sidebar.view).toBe(before);
  });

  it('renders only while open, and opens on Appearance by default', async () => {
    renderInShell(<SettingsPage />);
    expect(screen.queryByTestId('settings-page')).toBeNull();

    useUiStore.getState().openPreferences();
    const editor = await screen.findByTestId('preferences-editor');
    expect(currentSection(editor)).toBe('Appearance');
  });

  it('lands on the section the caller asked for', async () => {
    renderInShell(<SettingsPage />);
    useUiStore.getState().openPreferences('accounts');

    const editor = await screen.findByTestId('preferences-editor');
    await waitFor(() => {
      expect(currentSection(editor)).toBe('Accounts');
    });
  });

  it('still accepts the old editor and ui section ids, landing on Appearance', async () => {
    renderInShell(<SettingsPage />);
    useUiStore.getState().openPreferences('ui');
    const editor = await screen.findByTestId('preferences-editor');
    expect(currentSection(editor)).toBe('Appearance');
  });

  it('forgets that section on close, so a plain open lands on the default', async () => {
    renderInShell(<SettingsPage />);
    useUiStore.getState().openPreferences('accounts');
    await screen.findByTestId('preferences-editor');

    useUiStore.getState().setPreferencesOpen(false);
    await waitFor(() => {
      expect(screen.queryByTestId('preferences-editor')).toBeNull();
    });
    useUiStore.getState().openPreferences();

    const editor = await screen.findByTestId('preferences-editor');
    expect(currentSection(editor)).toBe('Appearance');
  });

  it('closes with Back to app', async () => {
    renderInShell(<SettingsPage />);
    useUiStore.getState().openPreferences();
    fireEvent.click(await screen.findByRole('button', { name: 'Back to app' }));
    expect(useUiStore.getState().preferences.open).toBe(false);
  });

  it('closes with Escape, but not while a field has focus or a search is in force', async () => {
    renderInShell(<SettingsPage />);
    useUiStore.getState().openPreferences();
    await screen.findByTestId('preferences-editor');

    // A text field keeps Escape for reverting its draft.
    fireEvent.keyDown(screen.getByLabelText('Tab size'), { key: 'Escape' });
    expect(useUiStore.getState().preferences.open).toBe(true);

    // With a search in force, the first Escape clears it…
    const search = screen.getByLabelText<HTMLInputElement>('Search settings');
    fireEvent.change(search, { target: { value: 'proxy' } });
    fireEvent.keyDown(search, { key: 'Escape' });
    expect(search.value).toBe('');
    expect(useUiStore.getState().preferences.open).toBe(true);

    // …and the next one leaves Settings.
    fireEvent.keyDown(search, { key: 'Escape' });
    expect(useUiStore.getState().preferences.open).toBe(false);
  });

  it('closes with Escape pressed on the page itself', async () => {
    renderInShell(<SettingsPage />);
    useUiStore.getState().openPreferences();
    await screen.findByTestId('preferences-editor');
    fireEvent.keyDown(screen.getByRole('button', { name: 'Behaviour' }), { key: 'Escape' });
    expect(useUiStore.getState().preferences.open).toBe(false);
  });

  it('closes on an Escape a tooltip already handled, and not on one an open menu spent (G06)', async () => {
    renderInShell(<SettingsPage />);
    useUiStore.getState().openPreferences();
    await screen.findByTestId('preferences-editor');
    // A tooltip (or any layer) marks Escape handled in the capture phase, before the page sees it.
    const claim = (event: KeyboardEvent): void => {
      event.preventDefault();
    };
    document.addEventListener('keydown', claim, { capture: true });
    try {
      // An open menu still owns the key.
      const menu = document.createElement('div');
      menu.setAttribute('role', 'menu');
      document.body.append(menu);
      fireEvent.keyDown(document.body, { key: 'Escape' });
      expect(useUiStore.getState().preferences.open).toBe(true);

      // With only a tooltip closing, Settings closes too.
      menu.remove();
      fireEvent.keyDown(document.body, { key: 'Escape' });
      expect(useUiStore.getState().preferences.open).toBe(false);
    } finally {
      document.removeEventListener('keydown', claim, { capture: true });
    }
  });

  it('focuses the search on Mod+F', async () => {
    renderInShell(<SettingsPage />);
    useUiStore.getState().openPreferences();
    await screen.findByTestId('preferences-editor');
    fireEvent.keyDown(window, { key: 'f', metaKey: true });
    expect(document.activeElement).toBe(screen.getByLabelText('Search settings'));
  });
});
