import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { browserDocumentTitle, useBrowserDocumentTitle } from '../../src/renderer/shell/document-title.js';
import { TitleBar } from '../../src/renderer/shell/title-bar.js';
import { useEditorsStore } from '../../src/renderer/state/editors.js';
import { useProjectStore } from '../../src/renderer/state/project.js';

vi.mock('../../src/renderer/features/environments/env-switcher.js', () => ({
  EnvSwitcher: () => <div data-testid="env-switcher-stub" />,
}));
vi.mock('../../src/renderer/features/workspace/switcher.js', () => ({
  WorkspaceSwitcher: () => <span>Workspace</span>,
}));

/** Makes the renderer think it runs in a browser tab (`env.host`), or on the desktop with no env at all. */
function asBrowserTab(browser: boolean): void {
  vi.stubGlobal('wirebench', browser ? { env: { host: 'browser', capabilities: ['send:public'] } } : undefined);
}

function Probe({ workspace }: { readonly workspace: string | null }) {
  useBrowserDocumentTitle(workspace);
  return null;
}

describe('browser tab title (#903)', () => {
  beforeEach(() => {
    useEditorsStore.getState().reset();
    document.title = 'Wirebench';
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('names the tab in front and the workspace, dropping what is missing', () => {
    expect(browserDocumentTitle('Request 1', 'wtest1')).toBe('Request 1 · wtest1 · Wirebench');
    expect(browserDocumentTitle(undefined, 'wtest1')).toBe('wtest1 · Wirebench');
    expect(browserDocumentTitle(undefined, null)).toBe('Wirebench');
  });

  it('follows the active tab in a browser tab', () => {
    asBrowserTab(true);
    render(<Probe workspace="wtest1" />);
    expect(document.title).toBe('wtest1 · Wirebench');
    act(() => {
      useEditorsStore.getState().open({ id: 'request:r1', kind: 'request', title: 'Request 1', requestId: 'r1' });
    });
    expect(document.title).toBe('Request 1 · wtest1 · Wirebench');
    act(() => {
      useEditorsStore.getState().showStart();
    });
    expect(document.title).toBe('wtest1 · Wirebench');
  });

  it('follows a rename of the tab in front (#916)', () => {
    asBrowserTab(true);
    const folder = (name: string) =>
      ({ id: 'f1', name }) as unknown as ReturnType<typeof useProjectStore.getState>['folders'][string];
    act(() => {
      useProjectStore.setState({ folders: { f1: folder('Orders') } });
      useEditorsStore.getState().open({ id: 'folder:f1', kind: 'folder', title: 'Orders', folderId: 'f1' });
    });
    render(<Probe workspace="wtest1" />);
    expect(document.title).toBe('Orders · wtest1 · Wirebench');
    act(() => {
      useProjectStore.setState({ folders: { f1: folder('Create order') } });
    });
    expect(document.title).toBe('Create order · wtest1 · Wirebench');
  });

  it('leaves the desktop window title alone', () => {
    asBrowserTab(false);
    render(<Probe workspace="wtest1" />);
    expect(document.title).toBe('Wirebench');
  });

  const renderMacTitleBar = () =>
    render(
      <TooltipPrimitive.Provider>
        <TitleBar
          platform="mac"
          workspaceName="Workspace"
          onOpenPalette={() => undefined}
          onToggleTheme={() => undefined}
        />
      </TooltipPrimitive.Provider>,
    );

  it('keeps the traffic-light gap on the Mac desktop and drops it in a browser tab', () => {
    asBrowserTab(false);
    renderMacTitleBar();
    expect(screen.getByTestId('title-bar').querySelector('.w-\\[68px\\]')).not.toBeNull();
    cleanup();
    asBrowserTab(true);
    renderMacTitleBar();
    expect(screen.getByTestId('title-bar').querySelector('.w-\\[68px\\]')).toBeNull();
  });
});
