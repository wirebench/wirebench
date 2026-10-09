import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AREAS } from '../../src/shared/area-module.js';
import { RENDERER_AREAS } from '../../src/renderer/areas/index.js';

vi.mock('../../src/renderer/features/explorer/explorer-view.js', () => ({ ExplorerView: () => <p>explorer-view</p> }));

describe('renderer areas', () => {
  it('has a renderer half for every shared area', () => {
    for (const area of AREAS) expect(RENDERER_AREAS[area.id].View).toBeTypeOf('function');
  });

  it('renders the explorer view for the explorer area', () => {
    const View = RENDERER_AREAS.explorer.View;
    render(<View />);
    expect(screen.getByText('explorer-view')).toBeTruthy();
  });
});

describe('enabled areas', () => {
  afterEach(async () => {
    const { useUiStore } = await import('../../src/renderer/state/ui.js');
    useUiStore.getState().setEnabledAreas(AREAS.map((area) => area.id));
    useUiStore.getState().setSidebarView('explorer');
  });

  it('hides a switched-off area from the rail and skips its command', async () => {
    const { ActivityBar } = await import('../../src/renderer/shell/activity-bar.js');
    const { registerViewCommands } = await import('../../src/renderer/commands/register-view-commands.js');
    const { resetCommands, getCommand } = await import('../../src/renderer/lib/commands.js');
    const { useUiStore } = await import('../../src/renderer/state/ui.js');
    useUiStore.getState().setEnabledAreas(['explorer', 'environments', 'search', 'history']);
    resetCommands();
    registerViewCommands(() => undefined);
    render(
      <TooltipPrimitive.Provider>
        <ActivityBar platform="mac" />
      </TooltipPrimitive.Provider>,
    );
    expect(screen.queryByLabelText('WS-Security')).toBeNull();
    expect(screen.getByLabelText('Explorer')).toBeTruthy();
    expect(getCommand('view.showWss')).toBeUndefined();
    expect(getCommand('view.showExplorer')).toBeDefined();
  });

  it('repairs a restored view that is switched off and refuses to show a disabled one', async () => {
    const { useUiStore } = await import('../../src/renderer/state/ui.js');
    const store = useUiStore.getState();
    store.setSidebarView('wss');
    expect(useUiStore.getState().sidebar.view).toBe('wss');
    store.setEnabledAreas(['explorer', 'environments', 'search', 'history']);
    expect(useUiStore.getState().sidebar.view).toBe('explorer');
    store.showSidebarView('wss');
    store.setSidebarView('wss');
    expect(useUiStore.getState().sidebar.view).toBe('explorer');
  });
});
