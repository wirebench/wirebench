import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WorkspaceSwitcher } from '../../src/renderer/features/workspace/switcher.js';
import { useUiStore } from '../../src/renderer/state/ui.js';
import { useWorkspaceStore } from '../../src/renderer/state/workspace.js';
import type { WorkspaceSummaryWire } from '../../src/shared/wire-types.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';
import { workspaceWire } from '../helpers/workspace-wire.js';

function summary(
  patch: Partial<WorkspaceSummaryWire> & Pick<WorkspaceSummaryWire, 'id' | 'name'>,
): WorkspaceSummaryWire {
  return {
    dir: `/tmp/workspaces/${patch.id}`,
    projectCount: 0,
    internalProjectCount: 0,
    createdAt: '2026-09-11T00:00:00.000Z',
    ...patch,
  };
}

const ROWS: readonly WorkspaceSummaryWire[] = [
  summary({ id: 'w1', name: 'Workspace 1' }),
  summary({ id: 'w2', name: 'Billing' }),
  summary({ id: 'w3', name: 'Broken', unreadable: true }),
];

describe('WorkspaceSwitcher', () => {
  beforeEach(() => {
    installWirebenchApi();
    useWorkspaceStore.setState({ workspace: workspaceWire(), workspaces: ROWS });
    useUiStore.setState({ workspaceSwitcherOpen: false, workspaceCreateOpen: false, workspaceManageOpen: false });
  });
  afterEach(() => {
    cleanup();
    useWorkspaceStore.setState({ workspace: null, workspaces: [] });
  });

  it('renders nothing with no workspace open', () => {
    useWorkspaceStore.setState({ workspace: null });
    render(<WorkspaceSwitcher />);

    expect(screen.queryByTestId('workspace-switcher')).toBeNull();
  });

  it('names the open workspace and lists every workspace', async () => {
    render(<WorkspaceSwitcher />);

    const trigger = screen.getByTestId('workspace-switcher');
    expect(trigger.getAttribute('aria-label')).toBe('Workspace: Workspace 1');

    await userEvent.click(trigger);

    const items = await screen.findAllByTestId('workspace-switcher-item');
    expect(items.map((item) => item.textContent)).toEqual(['Workspace 1', 'Billing', 'Broken']);
    expect(items[2]?.getAttribute('data-disabled')).not.toBeNull();
    expect(screen.getByText('Create workspace…')).toBeTruthy();
    expect(screen.getByText('Manage workspaces…')).toBeTruthy();
  });

  it('opens the workspace an item names, and ignores the open one', async () => {
    const open = vi
      .fn()
      .mockResolvedValue({ ok: true, value: { workspace: workspaceWire({ id: 'w2', name: 'Billing' }) } });
    installWirebenchApi({ workspace: { open } });
    render(<WorkspaceSwitcher />);

    await userEvent.click(screen.getByTestId('workspace-switcher'));
    const items = await screen.findAllByTestId('workspace-switcher-item');
    await userEvent.click(items[0] as HTMLElement);
    expect(open).not.toHaveBeenCalled();

    await userEvent.click(screen.getByTestId('workspace-switcher'));
    const reopened = await screen.findAllByTestId('workspace-switcher-item');
    await userEvent.click(reopened[1] as HTMLElement);

    await waitFor(() => expect(open).toHaveBeenCalledWith({ workspaceId: 'w2' }));
  });

  it('is reachable and operable from the keyboard alone', async () => {
    render(<WorkspaceSwitcher />);

    screen.getByTestId('workspace-switcher').focus();
    await userEvent.keyboard('{Enter}');

    await screen.findAllByTestId('workspace-switcher-item');
    // End jumps to the last item — *Manage workspaces…* — and Enter runs it.
    await userEvent.keyboard('{End}{Enter}');

    await waitFor(() => expect(useUiStore.getState().workspaceManageOpen).toBe(true));
  });

  it('opens the create dialog from its own item', async () => {
    render(<WorkspaceSwitcher />);

    await userEvent.click(screen.getByTestId('workspace-switcher'));
    await userEvent.click(await screen.findByText('Create workspace…'));

    await waitFor(() => expect(useUiStore.getState().workspaceCreateOpen).toBe(true));
  });

  it('opens when a command asks for it', async () => {
    render(<WorkspaceSwitcher />);

    act(() => {
      useUiStore.getState().setWorkspaceSwitcherOpen(true);
    });

    expect((await screen.findAllByTestId('workspace-switcher-item')).length).toBe(3);
  });
});
