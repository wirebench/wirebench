import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { ConsolePanel } from '../../src/renderer/shell/console-panel.js';
import { Sidebar } from '../../src/renderer/shell/sidebar.js';
import { DEFAULT_UI_STATE } from '../../src/renderer/state/ui-state.js';
import { useUiStore } from '../../src/renderer/state/ui.js';
import { useWorkspaceStore } from '../../src/renderer/state/workspace.js';

/**
 * Task 9's collapse/expand/restore behaviour: the store actions the sidebar, the console, the
 * drag handles and the status bar all share, plus the header collapse buttons that trigger them.
 * `panel-handle.test.tsx` covers the handle itself; `e2e/specs/layout.spec.ts` covers dragging
 * past the minimum, the status bar, and persistence across a relaunch.
 */
describe('sidebar/console collapse, expand and restore', () => {
  beforeEach(() => {
    useUiStore.setState(structuredClone(DEFAULT_UI_STATE));
    useWorkspaceStore.setState({ workspace: null });
  });

  afterEach(() => {
    cleanup();
  });

  it('collapseSidebar hides it and remembers its size as lastSize', () => {
    useUiStore.getState().setSidebarSize(31);

    useUiStore.getState().collapseSidebar();

    expect(useUiStore.getState().sidebar).toMatchObject({ visible: false, size: 31, lastSize: 31 });
  });

  it('collapseSidebar is a no-op while already hidden', () => {
    useUiStore.getState().setSidebarSize(31);
    useUiStore.getState().collapseSidebar();
    useUiStore.setState((state) => ({ sidebar: { ...state.sidebar, lastSize: 31 } }));

    useUiStore.getState().collapseSidebar();

    expect(useUiStore.getState().sidebar.lastSize).toBe(31);
  });

  it('expandSidebar restores lastSize and is a no-op while already visible', () => {
    useUiStore.getState().setSidebarSize(31);
    useUiStore.getState().collapseSidebar();
    useUiStore.getState().setSidebarSize(15); // resized while hidden must not matter (it can't be, but guard it)

    useUiStore.getState().expandSidebar();

    expect(useUiStore.getState().sidebar).toMatchObject({ visible: true, size: 31 });

    useUiStore.getState().setSidebarSize(18);
    useUiStore.getState().expandSidebar();
    expect(useUiStore.getState().sidebar.size).toBe(18);
  });

  it('restoreSidebarSize snaps a visible sidebar back to lastSize without collapsing it', () => {
    useUiStore.getState().setSidebarSize(35);

    useUiStore.getState().restoreSidebarSize();

    expect(useUiStore.getState().sidebar).toMatchObject({
      visible: true,
      size: DEFAULT_UI_STATE.sidebar.lastSize,
    });
  });

  it('restoreSidebarSize is a no-op while the sidebar is hidden', () => {
    useUiStore.getState().collapseSidebar();

    useUiStore.getState().restoreSidebarSize();

    expect(useUiStore.getState().sidebar.visible).toBe(false);
  });

  it('toggleSidebar collapses when visible and expands to lastSize when hidden', () => {
    useUiStore.getState().setSidebarSize(33);

    useUiStore.getState().toggleSidebar();
    expect(useUiStore.getState().sidebar).toMatchObject({ visible: false, lastSize: 33 });

    useUiStore.getState().toggleSidebar();
    expect(useUiStore.getState().sidebar).toMatchObject({ visible: true, size: 33 });
  });

  it('collapses / expands / restores the console the same way', () => {
    useUiStore.getState().setConsoleSize(44);

    useUiStore.getState().collapseConsole();
    expect(useUiStore.getState().console).toMatchObject({ visible: false, lastSize: 44 });

    useUiStore.getState().expandConsole();
    expect(useUiStore.getState().console).toMatchObject({ visible: true, size: 44 });

    useUiStore.getState().setConsoleSize(50);
    useUiStore.getState().restoreConsoleSize();
    expect(useUiStore.getState().console.size).toBe(44);
  });

  it('the sidebar header collapse button hides the sidebar', () => {
    render(
      <TooltipPrimitive.Provider>
        <Sidebar />
      </TooltipPrimitive.Provider>,
    );

    fireEvent.click(screen.getByTestId('sidebar-collapse'));

    expect(useUiStore.getState().sidebar.visible).toBe(false);
  });

  it('the console header collapse button hides the console', () => {
    render(
      <TooltipPrimitive.Provider>
        <ConsolePanel />
      </TooltipPrimitive.Provider>,
    );

    fireEvent.click(screen.getByTestId('console-collapse'));

    expect(useUiStore.getState().console.visible).toBe(false);
  });
});
