import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { NARROW_WINDOW_PX, NarrowWindowNote, useNarrowWindow } from '../../src/renderer/shell/narrow-window.js';
import { TitleBar } from '../../src/renderer/shell/title-bar.js';

vi.mock('../../src/renderer/features/environments/env-switcher.js', () => ({
  EnvSwitcher: () => <div data-testid="env-switcher-stub" />,
}));
vi.mock('../../src/renderer/features/workspace/switcher.js', () => ({
  WorkspaceSwitcher: () => <span>Workspace</span>,
}));

/** A `matchMedia` whose one query answers `matches` until `set` flips it, telling its listeners. */
function stubMatchMedia(initial: boolean) {
  let matches = initial;
  const listeners = new Set<() => void>();
  const queries: string[] = [];
  vi.stubGlobal('matchMedia', (query: string) => {
    queries.push(query);
    return {
      get matches() {
        return matches;
      },
      media: query,
      addEventListener: (_: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
    };
  });
  return {
    queries,
    set(next: boolean) {
      matches = next;
      for (const listener of listeners) listener();
    },
  };
}

function Probe() {
  return useNarrowWindow() ? <NarrowWindowNote /> : <div data-testid="workbench" />;
}

describe('narrow window (#890)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('shows the note below the breakpoint and the workbench again once the window widens', () => {
    const media = stubMatchMedia(true);
    render(<Probe />);
    expect(screen.getByTestId('narrow-window-note').textContent).toContain('Wirebench needs a wider window');
    expect(media.queries).toContain(`(max-width: ${String(NARROW_WINDOW_PX - 1)}px)`);
    act(() => {
      media.set(false);
    });
    expect(screen.queryByTestId('narrow-window-note')).toBeNull();
    expect(screen.getByTestId('workbench')).toBeTruthy();
  });

  it('shows the workbench where there is no matchMedia at all', () => {
    vi.stubGlobal('matchMedia', undefined);
    render(<Probe />);
    expect(screen.getByTestId('workbench')).toBeTruthy();
  });

  it('keeps the title-bar search box on one line, its hint hidden below the desktop minimum', () => {
    render(
      <TooltipPrimitive.Provider>
        <TitleBar
          platform="linux"
          workspaceName="Workspace"
          onOpenPalette={() => undefined}
          onToggleTheme={() => undefined}
        />
      </TooltipPrimitive.Provider>,
    );
    const search = screen.getByText('Search or run a command');
    expect(search.className).toContain('truncate');
    expect(search.closest('button')?.className).toContain('whitespace-nowrap');
    expect(screen.getByTestId('title-bar-palette-shortcut').className).toContain('max-[879px]:hidden');
  });
});
