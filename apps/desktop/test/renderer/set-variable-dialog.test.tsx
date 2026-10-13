/**
 * Set as Variable (#340): the scopes offered for a request, the name rules, the write each scope
 * makes, and the reference handed back — shorthand unless a nearer scope would shadow it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SetVariableDialog } from '../../src/renderer/features/environments/set-variable-dialog.js';
import { useGlobalsStore } from '../../src/renderer/state/globals.js';
import { useProjectStore } from '../../src/renderer/state/project.js';
import { useWorkspaceStore } from '../../src/renderer/state/workspace.js';
import type { RequestVariables } from '../../src/renderer/editor/variable-assist.js';
import { workspaceWire } from '../helpers/workspace-wire.js';

afterEach(() => {
  cleanup();
});

const variables: RequestVariables = {
  entries: [{ name: 'token', scope: 'Env', value: 'x', masked: false, shadowed: false }],
  secretNames: [],
};

function seedProject(): void {
  useProjectStore.setState({
    projects: {
      p1: {
        name: 'Shop',
        properties: { existing: '1' },
        environments: [{ id: 'e1', name: 'dev', slug: 'dev', order: 0, endpoints: {}, properties: {}, disabled: [] }],
        activeEnvironmentId: 'e1',
      },
    } as never,
  });
}

describe('SetVariableDialog', () => {
  beforeEach(() => {
    useWorkspaceStore.setState({ workspace: undefined } as never);
    useGlobalsStore.setState({ properties: {}, disabled: [] });
    seedProject();
  });

  it('offers the active environment, the project and globals, and writes to the one chosen', async () => {
    const setProjectProperty = vi.fn().mockResolvedValue(undefined);
    useProjectStore.setState({ setProjectProperty } as never);
    const onCreated = vi.fn();
    render(
      <SetVariableDialog
        selected="abc123"
        projectId="p1"
        variables={variables}
        onClose={vi.fn()}
        onCreated={onCreated}
      />,
    );
    const scope = screen.getByRole('combobox', { name: 'Variable scope' });
    expect([...scope.querySelectorAll('option')].map((option) => option.textContent)).toEqual([
      'Environment (dev)',
      'Project (Shop)',
      'Globals',
    ]);
    expect(screen.getByTestId('set-variable-value').textContent).toBe('abc123');

    fireEvent.change(screen.getByRole('textbox', { name: 'Variable name' }), { target: { value: 'token' } });
    fireEvent.change(scope, { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(setProjectProperty).toHaveBeenCalledWith('p1', 'token', 'abc123');
    // The environment's `token` would shadow the project's: the reference names the scope.
    expect(onCreated).toHaveBeenCalledWith('${#Project#token}');
  });

  it("inside a workspace, offers the request's own project's active environment (#468)", () => {
    const env = (id: string, name: string) => ({
      id,
      name,
      slug: name,
      order: 0,
      endpoints: {},
      properties: {},
      disabled: [],
    });
    useWorkspaceStore.setState({
      workspace: workspaceWire({
        environments: [env('w-dev', 'dev'), env('w-qa', 'qa')],
        activeEnvironments: { p1: 'w-qa', p2: 'w-dev' },
      }),
    });
    render(
      <SetVariableDialog selected="v" projectId="p1" variables={variables} onClose={vi.fn()} onCreated={vi.fn()} />,
    );
    const scope = screen.getByRole('combobox', { name: 'Variable scope' });
    expect([...scope.querySelectorAll('option')].map((option) => option.textContent)).toEqual([
      'Environment (qa)',
      'Project (Shop)',
      'Workspace',
      'Globals',
    ]);
  });

  it('hands back the shorthand when nothing nearer defines the name', async () => {
    const set = vi.fn().mockResolvedValue(undefined);
    useGlobalsStore.setState({ set } as never);
    const onCreated = vi.fn();
    render(
      <SetVariableDialog selected="v" projectId="p1" variables={variables} onClose={vi.fn()} onCreated={onCreated} />,
    );
    fireEvent.change(screen.getByRole('textbox', { name: 'Variable name' }), { target: { value: 'fresh' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Variable scope' }), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('${fresh}'));
    expect(set).toHaveBeenCalledWith('fresh', 'v');
  });

  it('refuses a name the syntax cannot carry, and asks before replacing one', () => {
    render(
      <SetVariableDialog selected="v" projectId="p1" variables={variables} onClose={vi.fn()} onCreated={vi.fn()} />,
    );
    const name = screen.getByRole('textbox', { name: 'Variable name' });
    const create = screen.getByRole('button', { name: 'Create' });
    fireEvent.change(name, { target: { value: 'two words' } });
    expect(screen.getByRole('alert').textContent).toContain('cannot hold spaces');
    expect((create as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByRole('combobox', { name: 'Variable scope' }), { target: { value: '1' } });
    fireEvent.change(name, { target: { value: 'existing' } });
    expect(screen.getByRole('alert').textContent).toBe('Project (Shop) already has "existing".');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Replace the existing value' }));
    expect(screen.queryByRole('alert')).toBeNull();
    expect((create as HTMLButtonElement).disabled).toBe(false);
  });
});
