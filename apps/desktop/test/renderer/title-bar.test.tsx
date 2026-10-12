import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
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

  it('shows the environment switcher over the workbench', () => {
    renderTitleBar();
    expect(screen.getByTestId('env-switcher-stub')).toBeTruthy();
  });

  it('hides the environment switcher while Settings is open', () => {
    useUiStore.getState().setPreferencesOpen(true);
    renderTitleBar();
    expect(screen.queryByTestId('env-switcher-stub')).toBeNull();
  });
});
