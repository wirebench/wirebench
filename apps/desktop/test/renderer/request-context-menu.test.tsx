import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { RequestContextMenu } from '../../src/renderer/features/request-editor/request-context-menu.js';
import { useRequestDialogsStore } from '../../src/renderer/features/request-editor/request-dialogs.js';
import { useProjectStore } from '../../src/renderer/state/project.js';
import { useUiStore } from '../../src/renderer/state/ui.js';
import { DEFAULT_UI_STATE } from '../../src/renderer/state/ui-state.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';
import { makeDraft } from '../mocks/exchange-fixtures.js';

// The menu's Format / Go to line items reach the live Monaco instance through
// `editor/xml-language.ts`; the real `monaco-editor` module cannot load under jsdom.
vi.mock('@monaco-editor/react', async () => await import('../mocks/monaco-editor-react.js'));
vi.mock('../../src/renderer/editor/monaco.js', async () => await import('../mocks/monaco-runtime.js'));

/** The items, in the order the brief fixes them. */
const ITEMS = [
  'Validate response',
  'Check WS-I compliance',
  'Go to Schema Definition',
  'Import cURL…',
  'Add WSS Username Token…',
  'Add WS-Timestamp…',
  'Outgoing WSS → Apply to editor',
  'Outgoing WSS → Remove',
  'WS-A Headers → Add to editor',
  'WS-A Headers → Remove',
  'Format',
  'Go to line…',
];

function openMenu(): void {
  render(
    <RequestContextMenu draft={makeDraft()}>
      <div data-testid="request-surface">envelope</div>
    </RequestContextMenu>,
  );
  fireEvent.contextMenu(screen.getByTestId('request-surface'));
}

describe('RequestContextMenu', () => {
  beforeEach(() => {
    installWirebenchApi();
    useUiStore.setState(structuredClone(DEFAULT_UI_STATE));
    useProjectStore.setState({ requests: { 'req-1': makeDraft() } });
    useRequestDialogsStore.getState().close();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('offers every request action, in order', async () => {
    openMenu();

    const labels = (await screen.findAllByRole('menuitem')).map((item) => item.textContent);
    expect(labels).toEqual(ITEMS);
  });

  it('Import cURL… hands its dialog to the editor that owns it', async () => {
    openMenu();

    fireEvent.click(await screen.findByRole('menuitem', { name: 'Import cURL…' }));
    expect(useRequestDialogsStore.getState()).toMatchObject({ kind: 'import-curl', requestId: 'req-1' });
  });

  it('leaves out the actions that live on the toolbar, in the explorer or in the palette', async () => {
    openMenu();

    await screen.findAllByRole('menuitem');
    for (const name of [
      'Validate request',
      'Recreate request (keep values)',
      'Recreate (discard values)',
      'Clone…',
      'Copy as cURL',
      'Copy as cURL (PowerShell)',
      'Show code',
      'Create empty',
    ]) {
      expect(screen.queryByRole('menuitem', { name })).toBeNull();
    }
  });
});
