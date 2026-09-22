import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SnapshotPanel } from '../../src/renderer/features/snapshot/snapshot-panel.js';
import { useEditorsStore } from '../../src/renderer/state/editors.js';
import { useSnapshotsStore } from '../../src/renderer/state/snapshots.js';
import type { SnapshotReadResponse } from '../../src/shared/wire-types.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';

const ok = <T,>(value: T) => ({ ok: true, value });

function present(body: string, ignore: string[] = [], contentType = 'application/json'): SnapshotReadResponse {
  return { status: 'present', snapshot: { body, ignore, contentType, savedAt: '2026-09-22T10:00:00.000Z' } };
}

function install(read: SnapshotReadResponse) {
  const api = {
    read: vi.fn().mockResolvedValue(ok(read)),
    write: vi.fn().mockResolvedValue(ok({ savedAt: '2026-09-22T11:00:00.000Z' })),
    setIgnore: vi.fn().mockResolvedValue(ok({ savedAt: '2026-09-22T10:00:00.000Z' })),
    remove: vi.fn().mockResolvedValue(ok({ removed: true })),
  };
  installWirebenchApi({ snapshot: api });
  return api;
}

describe('SnapshotPanel', () => {
  beforeEach(() => {
    useSnapshotsStore.setState({ entries: {} });
    useEditorsStore.setState({ tabs: [], activeId: undefined });
  });
  afterEach(cleanup);

  it('asks for a send when there is no response', () => {
    install({ status: 'none' });
    render(<SnapshotPanel requestId="r1" body={undefined} />);
    expect(screen.getByText('Send the request to compare its response.')).toBeTruthy();
  });

  it('asks for a saved project when the request is not on disk', async () => {
    install({ status: 'unsaved' });
    render(<SnapshotPanel requestId="r1" body="{}" contentType="application/json" />);
    expect(await screen.findByText('Save the project to keep a snapshot beside this request.')).toBeTruthy();
  });

  it('offers Save as snapshot when none is saved, and saves the body', async () => {
    const api = install({ status: 'none' });
    render(<SnapshotPanel requestId="r1" body='{"a":1}' contentType="application/json" />);
    expect(await screen.findByText('No snapshot saved.')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Save as snapshot' }));
    expect(api.write).toHaveBeenCalledWith({
      requestId: 'r1',
      body: '{"a":1}',
      contentType: 'application/json',
      ignore: [],
    });
  });

  it('says it matches, with the ignored count', async () => {
    install(present('{"a":1,"t":1}', ['/t']));
    render(<SnapshotPanel requestId="r1" body='{"a":1,"t":2}' contentType="application/json" />);
    expect(await screen.findByText('Matches the snapshot (1 ignored)')).toBeTruthy();
  });

  it('lists the differences in a table, and Ignore appends the path and saves it', async () => {
    const api = install(present('{"a":1,"b":2}', ['/z']));
    render(<SnapshotPanel requestId="r1" body='{"a":5,"b":6}' contentType="application/json" />);
    expect(await screen.findByText('2 differences')).toBeTruthy();
    const table = screen.getByRole('table', { name: 'Snapshot differences' });
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(3);
    expect(within(rows[1]!).getByText('/a')).toBeTruthy();
    await userEvent.click(within(rows[1]!).getByRole('button', { name: 'Ignore /a' }));
    expect(api.setIgnore).toHaveBeenCalledWith({ requestId: 'r1', ignore: ['/z', '/a'] });
    expect(await screen.findByText('1 difference (1 ignored)')).toBeTruthy();
  });

  it('shows an empty path as the root', async () => {
    install(present('1'));
    render(<SnapshotPanel requestId="r1" body="2" contentType="application/json" />);
    const table = await screen.findByRole('table', { name: 'Snapshot differences' });
    expect(within(table).getByText('/')).toBeTruthy();
  });

  it('saves the ignore rules on blur', async () => {
    const api = install(present('{"a":1}'));
    render(<SnapshotPanel requestId="r1" body='{"a":1}' contentType="application/json" />);
    const textarea = await screen.findByLabelText('Ignore rules');
    fireEvent.change(textarea, { target: { value: '/x\n# note\n//id' } });
    expect(api.setIgnore).not.toHaveBeenCalled();
    fireEvent.blur(textarea);
    await waitFor(() => expect(api.setIgnore).toHaveBeenCalledWith({ requestId: 'r1', ignore: ['/x', '//id'] }));
  });

  it('asks before Update snapshot overwrites the golden', async () => {
    const api = install(present('{"a":1}', ['/t']));
    render(<SnapshotPanel requestId="r1" body='{"a":2}' contentType="application/json" />);
    await userEvent.click(await screen.findByRole('button', { name: 'Update snapshot' }));
    expect(api.write).not.toHaveBeenCalled();
    const dialog = screen.getByRole('alertdialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Update' }));
    expect(api.write).toHaveBeenCalledWith({
      requestId: 'r1',
      body: '{"a":2}',
      contentType: 'application/json',
      ignore: ['/t'],
    });
  });

  it('deletes the snapshot', async () => {
    const api = install(present('{"a":1}'));
    render(<SnapshotPanel requestId="r1" body='{"a":1}' contentType="application/json" />);
    await userEvent.click(await screen.findByRole('button', { name: 'Delete snapshot' }));
    expect(api.remove).toHaveBeenCalledWith({ requestId: 'r1' });
    expect(await screen.findByText('No snapshot saved.')).toBeTruthy();
  });

  it('opens the diff tab with the golden on the left', async () => {
    install(present('{"a":1}'));
    render(<SnapshotPanel requestId="r1" body='{"a":2}' contentType="application/json" />);
    await userEvent.click(await screen.findByRole('button', { name: 'Compare side by side' }));
    const tab = useEditorsStore.getState().tabs.find((t) => t.kind === 'diff');
    expect(tab?.diff?.leftXml).toBe('{"a":1}');
    expect(tab?.diff?.rightXml).toBe('{"a":2}');
  });

  it('does not diff a body over 2 MB', async () => {
    install(present('{"a":1}'));
    const big = `"${'x'.repeat(2 * 1024 * 1024 + 1)}"`;
    render(<SnapshotPanel requestId="r1" body={big} contentType="application/json" />);
    expect(await screen.findByText('Too large to compare semantically')).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
  });
});
