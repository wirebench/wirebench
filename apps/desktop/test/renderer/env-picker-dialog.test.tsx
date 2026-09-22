import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EnvPickerDialog } from '../../src/renderer/features/multi-env/env-picker-dialog.js';
import {
  currentBlocker,
  sendToEnvironmentsBlocker,
  useMultiEnvState,
} from '../../src/renderer/features/multi-env/multi-env-actions.js';
import { renderHook } from '@testing-library/react';
import { useProjectStore } from '../../src/renderer/state/project.js';
import { useWorkspaceStore } from '../../src/renderer/state/workspace.js';
import type { ProjectWire } from '../../src/shared/wire-types.js';
import { workspaceWire } from '../helpers/workspace-wire.js';

const ENVS = [
  { id: 'dev', name: 'Dev' },
  { id: 'test', name: 'Test' },
  { id: 'prod', name: 'Prod' },
];

describe('EnvPickerDialog', () => {
  afterEach(() => {
    cleanup();
  });

  it('opens with the active environment ticked as baseline and Send disabled under two ticks', async () => {
    const onSend = vi.fn();
    render(<EnvPickerDialog open onOpenChange={vi.fn()} environments={ENVS} activeId="dev" onSend={onSend} />);

    expect(screen.getByLabelText<HTMLInputElement>('Include Dev').checked).toBe(true);
    expect(screen.getByLabelText<HTMLInputElement>('Baseline Dev').checked).toBe(true);
    expect(screen.getByLabelText<HTMLInputElement>('Baseline Test').disabled).toBe(true);
    const send = screen.getByTestId('env-picker-send');
    expect(send.hasAttribute('disabled')).toBe(true);

    await userEvent.click(screen.getByLabelText('Include Test'));
    expect(send.hasAttribute('disabled')).toBe(false);

    await userEvent.click(screen.getByLabelText('Baseline Test'));
    await userEvent.click(send);
    expect(onSend).toHaveBeenCalledWith({ ticked: ['dev', 'test'], baseline: 'test' });
  });

  it('moves the baseline when its environment is unticked', async () => {
    render(
      <EnvPickerDialog
        open
        onOpenChange={vi.fn()}
        environments={ENVS}
        activeId="dev"
        remembered={{ ticked: ['dev', 'test', 'prod'], baseline: 'test' }}
        onSend={vi.fn()}
      />,
    );
    expect(screen.getByLabelText<HTMLInputElement>('Baseline Test').checked).toBe(true);
    await userEvent.click(screen.getByLabelText('Include Test'));
    expect(screen.getByLabelText<HTMLInputElement>('Baseline Dev').checked).toBe(true);
  });
});

describe('sendToEnvironmentsBlocker', () => {
  it('blocks only with fewer than two environments, naming where they are missing', () => {
    expect(sendToEnvironmentsBlocker(1, false)).toMatch(/two or more environments in this project/);
    expect(sendToEnvironmentsBlocker(1, true)).toMatch(/two or more environments in this workspace/);
    expect(sendToEnvironmentsBlocker(0, true)).toBeDefined();
    expect(sendToEnvironmentsBlocker(2, false)).toBeUndefined();
    expect(sendToEnvironmentsBlocker(3, true)).toBeUndefined();
  });
});

describe('the environments *Send to environments…* offers', () => {
  const wsEnv = (id: string, order: number) => ({
    id,
    name: id.toUpperCase(),
    slug: id,
    order,
    properties: {},
    endpoints: {},
    disabled: [],
  });

  afterEach(() => {
    useWorkspaceStore.setState({ workspace: null });
  });

  it("lists the workspace's environments inside a workspace, not the project's", () => {
    useProjectStore.setState({
      projects: {
        p1: { id: 'p1', name: 'Demo', environments: [], activeEnvironmentId: undefined } as unknown as ProjectWire,
      },
      projectOf: { r1: 'p1' },
    });
    useWorkspaceStore.setState({
      workspace: workspaceWire({ environments: [wsEnv('wtest', 1), wsEnv('wdev', 0)], activeEnvironmentId: 'wdev' }),
    });
    expect(currentBlocker('r1')).toBeUndefined();
    const { result } = renderHook(() => useMultiEnvState('r1'));
    expect(result.current.environments.map((environment) => environment.id)).toEqual(['wdev', 'wtest']);
    expect(result.current.activeId).toBe('wdev');
    expect(result.current.blocker).toBeUndefined();
  });

  it('blocks inside a workspace with fewer than two workspace environments', () => {
    useProjectStore.setState({ projectOf: { r1: 'p1' } });
    useWorkspaceStore.setState({ workspace: workspaceWire({ environments: [wsEnv('wdev', 0)] }) });
    expect(currentBlocker('r1')).toMatch(/in this workspace/);
  });
});
