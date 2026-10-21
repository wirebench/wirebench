import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { OutgoingConfigEditor } from '../../src/renderer/features/wss/outgoing-config-editor.js';
import { WssConfigPanel } from '../../src/renderer/features/wss/wss-config-panel.js';
import { useWssConfigPanelStore } from '../../src/renderer/features/wss/wss-config-panel-store.js';
import { useProjectStore } from '../../src/renderer/state/project.js';
import type { WssOutgoingWire } from '../../src/shared/kinds/soap/wire.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';

const CONFIG: WssOutgoingWire = { id: 'w1', name: 'Gateway', mustUnderstand: false, entries: [] };

function setUp() {
  installWirebenchApi();
  const updateWssOutgoing = vi.fn().mockResolvedValue(undefined);
  const save = vi.fn(() => {
    useProjectStore.setState({ projects: { p1: { id: 'p1', name: 'Demo', dirty: false } } } as never);
    return Promise.resolve(true);
  });
  useProjectStore.setState({
    projects: { p1: { id: 'p1', name: 'Demo', dirty: false } },
    keystores: [],
    wssOutgoing: [{ ...CONFIG, projectId: 'p1' }],
    updateWssOutgoing,
    save,
  } as never);
  render(
    <TooltipPrimitive.Provider>
      <OutgoingConfigEditor />
      <WssConfigPanel />
    </TooltipPrimitive.Provider>,
  );
  return { updateWssOutgoing, save };
}

/** What an edit does to the mirror: the configuration changes and its project is dirty. */
function edit(name: string): void {
  act(() => {
    useProjectStore.setState({
      projects: { p1: { id: 'p1', name: 'Demo', dirty: true } },
      wssOutgoing: [{ ...CONFIG, name, projectId: 'p1' }],
    } as never);
  });
}

afterEach(() => {
  cleanup();
  useWssConfigPanelStore.setState({ editing: undefined, original: undefined, asking: false });
  useProjectStore.getState().reset();
});

describe('WS-Security configuration panel (#730)', () => {
  it('opens the configuration picked in the sidebar, beside it, with no unsaved mark', () => {
    setUp();
    fireEvent.click(screen.getByRole('button', { expanded: false }));
    expect(screen.getByTestId('wss-config-panel')).toBeTruthy();
    expect(screen.getByTestId('wss-outgoing-editor')).toBeTruthy();
    expect(screen.queryByTestId('wss-config-unsaved')).toBeNull();
    expect(screen.getByRole('button', { expanded: true })).toBeTruthy();
  });

  it('marks an edit unsaved, and closing asks; Don’t save puts the configuration back', async () => {
    const { updateWssOutgoing } = setUp();
    fireEvent.click(screen.getByRole('button', { expanded: false }));
    edit('Renamed');
    expect(screen.getByTestId('wss-config-unsaved')).toBeTruthy();

    act(() => {
      useWssConfigPanelStore.getState().requestClose();
    });
    fireEvent.click(await screen.findByTestId('wss-config-discard'));
    await waitFor(() => expect(useWssConfigPanelStore.getState().editing).toBeUndefined());
    expect(updateWssOutgoing).toHaveBeenCalledWith('w1', {
      name: 'Gateway',
      defaultAlias: null,
      defaultPasswordRef: null,
      actor: null,
      mustUnderstand: false,
      entries: [],
    });
  });

  it('Save writes the project and clears the mark; a saved configuration closes without asking', async () => {
    const { save } = setUp();
    fireEvent.click(screen.getByRole('button', { expanded: false }));
    edit('Renamed');
    fireEvent.click(screen.getByTestId('wss-config-save'));
    await waitFor(() => expect(save).toHaveBeenCalledWith('p1'));
    await waitFor(() => expect(screen.queryByTestId('wss-config-unsaved')).toBeNull());

    act(() => {
      useWssConfigPanelStore.getState().requestClose();
    });
    expect(useWssConfigPanelStore.getState().asking).toBe(false);
    expect(useWssConfigPanelStore.getState().editing).toBeUndefined();
  });

  it('Cancel keeps the configuration open with its edit', async () => {
    setUp();
    fireEvent.click(screen.getByRole('button', { expanded: false }));
    edit('Renamed');
    act(() => {
      useWssConfigPanelStore.getState().requestClose();
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(useWssConfigPanelStore.getState().asking).toBe(false));
    expect(useWssConfigPanelStore.getState().editing).toEqual({ direction: 'outgoing', id: 'w1' });
  });
});
