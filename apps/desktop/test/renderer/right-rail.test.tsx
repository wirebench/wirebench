import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { useForwardsStore } from '../../src/renderer/features/ssh/forwarding/forwards-store.js';
import { useHostsStore } from '../../src/renderer/features/ssh/hosts-store.js';
import { RightRail } from '../../src/renderer/shell/right-rail.js';
import { useEditorsStore } from '../../src/renderer/state/editors.js';
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
    useEditorsStore.setState({ displayedSet: 'explorer' });
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

  it('on the Port forwarding view shows Forward details instead of Host details, off until a row is picked', async () => {
    const editors = useEditorsStore.getState();
    const hosts = useHostsStore.getState();
    useEditorsStore.setState({ displayedSet: 'ssh', activeId: undefined } as never);
    useHostsStore.setState({ homeView: 'forwarding' } as never);
    useForwardsStore.getState().reset();
    try {
      renderRail();
      expect(screen.queryByRole('button', { name: 'Host details' })).toBeNull();
      const icon = screen.getByTestId('rail-forward-details');
      expect(icon.hasAttribute('disabled')).toBe(true);
      cleanup();
      useForwardsStore.getState().select('db-1/pg');
      useForwardsStore.getState().setDetailsOpen(false);
      renderRail();
      await userEvent.setup().click(screen.getByTestId('rail-forward-details'));
      expect(useForwardsStore.getState().detailsOpen).toBe(true);
    } finally {
      useEditorsStore.setState(editors, true);
      useHostsStore.setState(hosts, true);
      useForwardsStore.getState().reset();
    }
  });

  it('has no Code icon while an environment tab is in front', () => {
    useEditorsStore.setState({
      tabs: [{ id: 'env:e1', kind: 'environment', title: 'prod', environmentId: 'e1' }] as never,
      activeId: 'env:e1',
      displayedSet: 'explorer',
    });
    renderRail();

    expect(screen.queryByTestId('rail-code')).toBeNull();
  });
});
