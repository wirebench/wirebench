import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { RightRail } from '../../src/renderer/shell/right-rail.js';
import { DEFAULT_UI_STATE } from '../../src/renderer/state/ui-state.js';
import { useUiStore } from '../../src/renderer/state/ui.js';

function renderRail() {
  render(
    <TooltipPrimitive.Provider>
      <RightRail platform="mac" />
    </TooltipPrimitive.Provider>,
  );
}

describe('RightRail', () => {
  beforeEach(() => {
    useUiStore.setState(structuredClone(DEFAULT_UI_STATE));
  });

  afterEach(() => {
    cleanup();
  });

  it('renders the rail with its Code icon', () => {
    renderRail();

    expect(screen.getByTestId('right-rail')).toBeTruthy();
    expect(screen.getByTestId('rail-code')).toBeTruthy();
  });

  it('toggles the Code slide-over open and closed', async () => {
    const user = userEvent.setup();
    renderRail();

    expect(useUiStore.getState().slideOver.open).toBe(false);
    expect(screen.getByTestId('rail-code').getAttribute('aria-expanded')).toBe('false');

    await user.click(screen.getByTestId('rail-code'));
    expect(useUiStore.getState().slideOver.open).toBe(true);
    expect(screen.getByTestId('rail-code').getAttribute('aria-expanded')).toBe('true');

    await user.click(screen.getByTestId('rail-code'));
    expect(useUiStore.getState().slideOver.open).toBe(false);
    expect(screen.getByTestId('rail-code').getAttribute('aria-expanded')).toBe('false');
  });

  it('points `aria-controls` at the slide-over and carries no redundant `aria-pressed`', () => {
    renderRail();

    const rail = screen.getByTestId('rail-code');
    expect(rail.getAttribute('aria-controls')).toBe('slide-over');
    expect(rail.hasAttribute('aria-pressed')).toBe(false);
  });
});
