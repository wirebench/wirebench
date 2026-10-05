/**
 * The folder credentials dialog.
 *
 * A webhook folder is not a Kerberos surface (a delivery is not signed in as the user), so its form
 * leaves Kerberos out; an ordinary REST folder offers it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { FolderAuthDialog } from '../../src/renderer/features/rest-api/folder-auth-dialog.js';
import { useProjectStore } from '../../src/renderer/state/project.js';
import { useUiStore } from '../../src/renderer/state/ui.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';
import { restFolderWire } from '../helpers/wire-defaults.js';

beforeEach(() => {
  installWirebenchApi();
  useProjectStore.setState({
    folders: {
      'folder-1': restFolderWire({ id: 'folder-1' }),
      'wh-folder': restFolderWire({ id: 'wh-folder', apiId: 'webhooks:p1', name: 'Orders' }),
    },
  });
});

afterEach(() => {
  act(() => {
    useUiStore.getState().setFolderAuthId(undefined);
  });
  cleanup();
});

function offered(): (string | null)[] {
  return [...screen.getByLabelText('Folder authentication type').querySelectorAll('option')].map(
    (option) => option.textContent,
  );
}

describe('FolderAuthDialog', () => {
  it('offers Kerberos on an ordinary REST folder', () => {
    render(<FolderAuthDialog />);
    act(() => {
      useUiStore.getState().setFolderAuthId('folder-1');
    });

    expect(offered()).toContain('Kerberos');
  });

  it('does not offer Kerberos on a webhook folder', () => {
    render(<FolderAuthDialog />);
    act(() => {
      useUiStore.getState().setFolderAuthId('wh-folder');
    });

    expect(offered()).not.toContain('Kerberos');
  });
});
