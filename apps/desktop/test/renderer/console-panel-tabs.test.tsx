import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import type { InterfaceWire } from '../../src/shared/kinds/soap/wire.js';
import { ConsolePanel } from '../../src/renderer/shell/console-panel.js';
import { useProjectStore } from '../../src/renderer/state/project.js';
import { DEFAULT_UI_STATE } from '../../src/renderer/state/ui-state.js';
import { useUiStore } from '../../src/renderer/state/ui.js';
import { useWsiStore } from '../../src/renderer/state/wsi.js';

vi.mock('@monaco-editor/react', async () => await import('../mocks/monaco-editor-react.js'));
vi.mock('../../src/renderer/editor/monaco.js', async () => await import('../mocks/monaco-runtime.js'));

function renderConsole(): void {
  render(
    <TooltipPrimitive.Provider>
      <ConsolePanel />
    </TooltipPrimitive.Provider>,
  );
}

describe('the console tabs', () => {
  beforeEach(() => {
    useUiStore.setState({
      ...structuredClone(DEFAULT_UI_STATE),
      console: { ...DEFAULT_UI_STATE.console, visible: true, openOnFirstSend: false },
    });
    useProjectStore.setState({ interfaces: {} });
  });

  afterEach(() => {
    cleanup();
  });

  it('has no WS-I Report tab in a workspace without a SOAP interface', () => {
    renderConsole();
    expect(screen.queryByRole('tab', { name: 'WS-I Report' })).toBeNull();
    expect(screen.getByRole('tab', { name: 'HTTP Log' })).toBeTruthy();
  });

  it('shows the WS-I Report tab only once a check has run (#731 X17)', () => {
    useProjectStore.setState({ interfaces: { i1: { id: 'i1' } as unknown as InterfaceWire } });
    useWsiStore.setState({ status: 'idle', report: undefined });
    const view = render(
      <TooltipPrimitive.Provider>
        <ConsolePanel />
      </TooltipPrimitive.Provider>,
    );
    expect(screen.queryByRole('tab', { name: 'WS-I Report' })).toBeNull();

    useWsiStore.setState({ status: 'running' });
    view.rerender(
      <TooltipPrimitive.Provider>
        <ConsolePanel />
      </TooltipPrimitive.Provider>,
    );
    expect(screen.getByRole('tab', { name: 'WS-I Report' })).toBeTruthy();
    useWsiStore.setState({ status: 'idle' });
  });

  it('falls back to the HTTP Log when the WS-I tab was left active and the SOAP interface is gone', () => {
    useUiStore.setState((state) => ({ console: { ...state.console, activeTab: 'ws-i-report' } }));
    renderConsole();
    expect(screen.getByRole('tab', { name: 'HTTP Log' }).getAttribute('aria-selected')).toBe('true');
  });
});
