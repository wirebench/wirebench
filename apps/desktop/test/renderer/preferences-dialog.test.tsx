import { afterEach, describe, expect, it } from 'vitest';
import type { ReactElement } from 'react';
import * as Tooltip from '@radix-ui/react-tooltip';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ActivityBar } from '../../src/renderer/shell/activity-bar.js';
import { PreferencesDialog } from '../../src/renderer/features/preferences/preferences-dialog.js';
import { useUiStore } from '../../src/renderer/state/ui.js';

/** The shell supplies the tooltip provider that `IconButton` needs; a bare render does not. */
function renderInShell(ui: ReactElement) {
  return render(<Tooltip.Provider>{ui}</Tooltip.Provider>);
}

afterEach(() => {
  cleanup();
  useUiStore.setState({ preferences: { open: false, section: undefined } });
});

describe('Settings as a dialog', () => {
  it('opens the dialog from the activity bar rather than a sidebar view', async () => {
    const before = useUiStore.getState().sidebar.view;
    renderInShell(<ActivityBar platform="mac" />);

    fireEvent.click(screen.getByRole('button', { name: /Settings/ }));

    await waitFor(() => {
      expect(useUiStore.getState().preferences.open).toBe(true);
    });
    // The rail's other buttons swap the sidebar; this one must leave it exactly where it was.
    expect(useUiStore.getState().sidebar.view).toBe(before);
  });

  it('renders the preferences editor only while open', async () => {
    renderInShell(<PreferencesDialog />);
    expect(screen.queryByTestId('preferences-dialog')).toBeNull();

    useUiStore.getState().openPreferences();
    await waitFor(() => {
      expect(screen.getByTestId('preferences-editor')).toBeTruthy();
    });
  });

  it('lands on the section the caller asked for', async () => {
    renderInShell(<PreferencesDialog />);
    useUiStore.getState().openPreferences('ui');

    const editor = await screen.findByTestId('preferences-editor');
    await waitFor(() => {
      expect(editor.querySelector('[aria-current="page"]')?.textContent).toBe('UI');
    });
  });

  it('forgets that section on close, so a plain open lands on the default', async () => {
    renderInShell(<PreferencesDialog />);
    useUiStore.getState().openPreferences('ui');
    await screen.findByTestId('preferences-editor');

    useUiStore.getState().setPreferencesOpen(false);
    await waitFor(() => {
      expect(screen.queryByTestId('preferences-editor')).toBeNull();
    });
    useUiStore.getState().openPreferences();

    const editor = await screen.findByTestId('preferences-editor');
    await waitFor(() => {
      expect(editor.querySelector('[aria-current="page"]')?.textContent).toBe('HTTP');
    });
  });
});
