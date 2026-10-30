import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { TitleBar } from '../../src/renderer/shell/title-bar.js';
import { useUiStore } from '../../src/renderer/state/ui.js';

vi.mock('../../src/renderer/features/environments/env-switcher.js', () => ({
  EnvSwitcher: () => <div data-testid="env-switcher-stub" />,
}));
vi.mock('../../src/renderer/features/workspace/switcher.js', () => ({
  WorkspaceSwitcher: () => <span>Workspace</span>,
}));

function renderTitleBar() {
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
}

describe('TitleBar', () => {
  afterEach(() => {
    cleanup();
    useUiStore.getState().setPreferencesOpen(false);
  });

  it('paints itself as window chrome, so a colour theme can recolour the frame', () => {
    renderTitleBar();
    const bar = screen.getByTestId('title-bar');
    expect(bar.hasAttribute('data-chrome')).toBe(true);
    expect(bar.className).toContain('bg-surface-chrome');
    expect(bar.className).not.toContain('bg-surface-sunken');
  });

  it('shows the environment switcher over the workbench', () => {
    renderTitleBar();
    expect(screen.getByTestId('env-switcher-stub')).toBeTruthy();
  });

  it('hides the environment switcher while Settings is open', () => {
    useUiStore.getState().setPreferencesOpen(true);
    renderTitleBar();
    expect(screen.queryByTestId('env-switcher-stub')).toBeNull();
  });

  it('shows Ctrl+Shift+P while a terminal has the focus, where Ctrl+K goes to the shell (#537)', () => {
    const holder = document.createElement('div');
    holder.className = 'xterm';
    const input = document.createElement('textarea');
    holder.append(input);
    document.body.append(holder);
    renderTitleBar();
    const hint = screen.getByTestId('title-bar-palette-shortcut');
    // The palette's own shortcut (none is registered in this test), not the terminal's.
    const usual = hint.textContent;
    expect(usual).not.toBe('Ctrl+Shift+P');
    act(() => {
      input.focus();
    });
    expect(hint.textContent).toBe('Ctrl+Shift+P');
    act(() => {
      input.blur();
    });
    expect(hint.textContent).toBe(usual);
    holder.remove();
  });
});
