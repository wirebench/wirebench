import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { GetDataDialog } from '../../src/renderer/features/request-editor/views/get-data-dialog.js';
import { useGlobalsStore } from '../../src/renderer/state/globals.js';
import { useProjectStore } from '../../src/renderer/state/project.js';
import type { ProjectWire } from '../../src/renderer/../shared/wire-types.js';
import { PROJECT_SETTINGS } from '../helpers/wire-defaults.js';

const PROJECT: ProjectWire = {
  settings: PROJECT_SETTINGS,
  id: 'p1',
  name: 'Demo',
  dir: '/tmp/demo',
  dirty: false,
  interfaces: [],
  requests: [],
  properties: { host: 'example.test' },
  environments: [{ id: 'e1', name: 'QA', slug: 'qa', order: 0, endpoints: {}, properties: { user: 'qa-bot' } }],
  activeEnvironmentId: 'e1',
  problems: [],
  keystores: [],
};

describe('GetDataDialog', () => {
  beforeEach(() => {
    useProjectStore.getState().applySnapshot(PROJECT);
    useGlobalsStore.getState().applyProperties({ token: 'abc' });
  });

  afterEach(() => {
    cleanup();
    useProjectStore.getState().applySnapshot(null);
    useGlobalsStore.getState().applyProperties({});
  });

  it('lists project, environment and global properties', () => {
    render(<GetDataDialog open onOpenChange={vi.fn()} onInsert={vi.fn()} fieldLabel="tem:intA" />);

    expect(screen.getByText('host')).toBeDefined();
    expect(screen.getByText('user')).toBeDefined();
    expect(screen.getByText('token')).toBeDefined();
    expect(screen.getByText('Get Data — tem:intA')).toBeDefined();
  });

  it('inserts the chosen property as a scoped reference and closes', async () => {
    const onInsert = vi.fn();
    const onOpenChange = vi.fn();
    render(<GetDataDialog open onOpenChange={onOpenChange} onInsert={onInsert} fieldLabel="tem:intA" />);

    await userEvent.click(screen.getByText('host'));

    expect(onInsert).toHaveBeenCalledWith('${#Project#host}');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('uses the Env and Global scopes for their own properties', async () => {
    const onInsert = vi.fn();
    render(<GetDataDialog open onOpenChange={vi.fn()} onInsert={onInsert} fieldLabel="f" />);

    await userEvent.click(screen.getByText('user'));
    expect(onInsert).toHaveBeenCalledWith('${#Env#user}');

    cleanup();
    render(<GetDataDialog open onOpenChange={vi.fn()} onInsert={onInsert} fieldLabel="f" />);
    await userEvent.click(screen.getByText('token'));
    expect(onInsert).toHaveBeenLastCalledWith('${#Global#token}');
  });

  it('filters the list by name', async () => {
    render(<GetDataDialog open onOpenChange={vi.fn()} onInsert={vi.fn()} fieldLabel="f" />);

    await userEvent.type(screen.getByLabelText('Filter properties'), 'tok');

    expect(screen.getByText('token')).toBeDefined();
    expect(screen.queryByText('host')).toBeNull();
  });
});
