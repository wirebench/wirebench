import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ResolvedHostWire } from '@wirebench/wire/ssh-wire';
import { HostPicker, rankHostGroups } from '../../src/renderer/features/ssh/panes/host-picker.js';
import { useHostsStore } from '../../src/renderer/features/ssh/hosts-store.js';

/** A resolved host with what the picker reads; the ids are long and full of digits, as real ones are. */
function host(id: string, name: string, address: string): ResolvedHostWire {
  return { id, name, address, path: [], tags: [], ssh: {}, forwards: [] } as unknown as ResolvedHostWire;
}

const BOX_1 = host('2f6c1e2a-9b2d-4c22-8e2f-222222222221', 'box-1', '10.0.0.1');
const BOX_2 = host('7a1d4b3c-1e5f-4a6b-9c7d-111111111112', 'box-2', '10.0.0.2');
const DB = host('0c9e8d7f-2a3b-4c5d-8e9f-333333333333', 'db', 'db.example');
const TWIN = host('5e4d3c2b-1a09-4f8e-8d7c-444444444444', 'box-2', '10.0.0.9');

beforeEach(() => {
  useHostsStore.setState({ resolved: [BOX_1, BOX_2, DB], panes: {} });
});

afterEach(cleanup);

function selected(): string {
  return document.querySelector('[cmdk-item][data-selected="true"]')?.textContent ?? '';
}

describe('HostPicker', () => {
  it('starts on the current host, so Enter keeps the split on it', async () => {
    const onPick = vi.fn();
    render(<HostPicker initialHostId={BOX_1.id} onPick={onPick} onCancel={vi.fn()} />);
    expect(selected()).toContain('box-1');
    await userEvent.keyboard('{Enter}');
    expect(onPick).toHaveBeenCalledWith(BOX_1.id);
  });

  it('typing another host selects it, and Enter opens the pane on that host (#687)', async () => {
    const onPick = vi.fn();
    render(<HostPicker initialHostId={BOX_1.id} onPick={onPick} onCancel={vi.fn()} />);
    await userEvent.type(screen.getByTestId('ssh-pane-host-input'), 'box-2');
    expect(selected()).toContain('box-2');
    await userEvent.keyboard('{Enter}');
    expect(onPick).toHaveBeenCalledWith(BOX_2.id);
  });

  it('matches on the name and address, never the id', async () => {
    render(<HostPicker initialHostId={BOX_1.id} onPick={vi.fn()} onCancel={vi.fn()} />);
    await userEvent.type(screen.getByTestId('ssh-pane-host-input'), '4c22');
    expect(screen.getByText('No matching host.')).toBeDefined();
  });

  it('keeps two hosts of the same name apart', async () => {
    useHostsStore.setState({ resolved: [BOX_1, BOX_2, TWIN] });
    const onPick = vi.fn();
    render(<HostPicker initialHostId={BOX_1.id} onPick={onPick} onCancel={vi.fn()} />);
    await userEvent.type(screen.getByTestId('ssh-pane-host-input'), '10.0.0.9');
    expect(document.querySelectorAll('[cmdk-item][data-selected="true"]')).toHaveLength(1);
    await userEvent.keyboard('{Enter}');
    expect(onPick).toHaveBeenCalledWith(TWIN.id);
  });
});

describe('rankHostGroups', () => {
  const groups = [['Same host', [BOX_1]] as const, ['Other hosts', [BOX_2, DB]] as const];

  it('keeps the order for an empty search', () => {
    expect(rankHostGroups(groups, ' ').map(([heading]) => heading)).toEqual(['Same host', 'Other hosts']);
  });

  it('puts the group with the best match first', () => {
    expect(rankHostGroups(groups, 'box-2').map(([heading]) => heading)).toEqual(['Other hosts', 'Same host']);
    expect(rankHostGroups(groups, 'box-1').map(([heading]) => heading)).toEqual(['Same host', 'Other hosts']);
  });
});
