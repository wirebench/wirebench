import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { DetailsPanel } from '../../src/renderer/shell/details-panel.js';
import { useGlobalsStore } from '../../src/renderer/state/globals.js';
import { useProjectStore } from '../../src/renderer/state/project.js';
import { useUiStore } from '../../src/renderer/state/ui.js';
import type { ProjectWire } from '../../src/shared/wire-types.js';

const project = {
  id: 'p1',
  name: 'Demo',
  dir: '/tmp/demo',
  dirty: false,
  interfaces: [],
  requests: [],
  properties: { host: 'example.test' },
  environments: [],
  problems: [],
} as unknown as ProjectWire;

function renderPanel() {
  render(
    <TooltipPrimitive.Provider>
      <DetailsPanel />
    </TooltipPrimitive.Provider>,
  );
}

describe('DetailsPanel', () => {
  beforeEach(() => {
    useUiStore.setState({ selection: undefined });
    useProjectStore.setState({ project: null });
    useGlobalsStore.setState({ properties: {} });
  });

  afterEach(() => {
    cleanup();
  });

  it('says nothing is selected by default', () => {
    renderPanel();
    expect(screen.getByText('Nothing selected')).toBeDefined();
  });

  it('edits the project properties when the Project row is selected', async () => {
    const setProjectProperty = vi.fn().mockResolvedValue(undefined);
    useProjectStore.setState({ project, setProjectProperty });
    useUiStore.setState({ selection: { kind: 'project', id: 'project' } });
    renderPanel();

    expect(screen.getByLabelText<HTMLInputElement>('Value of host').value).toBe('example.test');

    fireEvent.change(screen.getByLabelText('New property name'), { target: { value: 'port' } });
    fireEvent.change(screen.getByLabelText('New property value'), { target: { value: '8080' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add property' }));
    await waitFor(() => {
      expect(setProjectProperty).toHaveBeenCalledWith('port', '8080');
    });
  });

  it('edits global properties from its own tab, with no project open', async () => {
    const set = vi.fn().mockResolvedValue(undefined);
    useGlobalsStore.setState({ properties: { token: 'abc' }, set });
    renderPanel();

    fireEvent.click(screen.getByRole('tab', { name: 'Global properties' }));
    expect(screen.getByLabelText<HTMLInputElement>('Value of token').value).toBe('abc');

    const value = screen.getByLabelText('Value of token');
    fireEvent.change(value, { target: { value: 'xyz' } });
    fireEvent.blur(value);
    await waitFor(() => {
      expect(set).toHaveBeenCalledWith('token', 'xyz');
    });
  });
});
