import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SnapshotPanel } from '../../src/renderer/features/snapshot/snapshot-panel.js';
import { useEditorsStore } from '../../src/renderer/state/editors.js';
import { useProjectStore } from '../../src/renderer/state/project.js';
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
    useSnapshotsStore.setState({ entries: {}, failed: {} });
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

  it('shows a root change at "/", and Ignore saves "/"', async () => {
    const api = install(present('1'));
    render(<SnapshotPanel requestId="r1" body="2" contentType="application/json" />);
    const table = await screen.findByRole('table', { name: 'Snapshot differences' });
    expect(within(table).getByText('/')).toBeTruthy();
    await userEvent.click(within(table).getByRole('button', { name: 'Ignore /' }));
    expect(api.setIgnore).toHaveBeenCalledWith({ requestId: 'r1', ignore: ['/'] });
    expect(await screen.findByText('Matches the snapshot (1 ignored)')).toBeTruthy();
  });

  it('reads again once the project is saved', async () => {
    const api = install({ status: 'unsaved' });
    useProjectStore.setState({ projectOf: { r1: 'p1' }, projects: {} });
    try {
      render(<SnapshotPanel requestId="r1" body="{}" contentType="application/json" />);
      expect(await screen.findByText('Save the project to keep a snapshot beside this request.')).toBeTruthy();
      api.read.mockResolvedValue(ok({ status: 'none' }));
      act(() => {
        useProjectStore.setState({
          projects: { p1: { id: 'p1', lastSavedAt: '2026-09-22T12:00:00.000Z' } as never },
        });
      });
      expect(await screen.findByText('No snapshot saved.')).toBeTruthy();
      expect(api.read).toHaveBeenCalledTimes(2);
    } finally {
      useProjectStore.getState().reset();
    }
  });

  it('saves the ignore rules on blur', async () => {
    const api = install(present('{"a":1}'));
    render(<SnapshotPanel requestId="r1" body='{"a":1}' contentType="application/json" />);
    const textarea = await screen.findByLabelText('Ignore rules');
    fireEvent.change(textarea, { target: { value: '/x\n# note\n//id' } });
    expect(api.setIgnore).not.toHaveBeenCalled();
    fireEvent.blur(textarea);
    await waitFor(() =>
      expect(api.setIgnore).toHaveBeenCalledWith({ requestId: 'r1', ignore: ['/x', '# note', '//id'] }),
    );
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
    expect(screen.queryByLabelText('Ignore rules')).toBeNull();
    expect(screen.getByRole('button', { name: 'Update snapshot' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Delete snapshot' })).toBeTruthy();
  });

  it('composes a typed rule with a row Ignore clicked straight after', async () => {
    const api = install(present('{"a":1}'));
    render(<SnapshotPanel requestId="r1" body='{"a":2}' contentType="application/json" />);
    await userEvent.type(await screen.findByLabelText('Ignore rules'), '/x');
    await userEvent.click(screen.getByRole('button', { name: 'Ignore /a' }));
    await waitFor(() => expect(api.setIgnore).toHaveBeenLastCalledWith({ requestId: 'r1', ignore: ['/x', '/a'] }));
  });

  it('composes two quick Ignore clicks', async () => {
    const api = install(present('{"a":1,"b":1}'));
    render(<SnapshotPanel requestId="r1" body='{"a":2,"b":2}' contentType="application/json" />);
    // The first write never answers, so the second click happens while it is still in flight.
    api.setIgnore.mockReturnValueOnce(new Promise(() => undefined));
    fireEvent.click(await screen.findByRole('button', { name: 'Ignore /a' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Ignore /b' }));
    await waitFor(() => expect(api.setIgnore).toHaveBeenLastCalledWith({ requestId: 'r1', ignore: ['/a', '/b'] }));
  });

  it('keeps comment lines in the saved rules and skips them when diffing', async () => {
    const api = install(present('{"a":1}'));
    render(<SnapshotPanel requestId="r1" body='{"a":2}' contentType="application/json" />);
    const textarea = await screen.findByLabelText<HTMLTextAreaElement>('Ignore rules');
    fireEvent.change(textarea, { target: { value: '  # volatile  \n\n/a' } });
    fireEvent.blur(textarea);
    await waitFor(() => expect(api.setIgnore).toHaveBeenCalledWith({ requestId: 'r1', ignore: ['# volatile', '/a'] }));
    expect(await screen.findByText('Matches the snapshot (1 ignored)')).toBeTruthy();
    expect(textarea.value).toContain('# volatile');
  });

  it('drops a read that lands after a newer write', async () => {
    let resolveRead: (value: unknown) => void = () => undefined;
    const read = vi.fn().mockReturnValue(new Promise((resolve) => (resolveRead = resolve)));
    const remove = vi.fn().mockResolvedValue(ok({ removed: true }));
    installWirebenchApi({ snapshot: { read, remove } });
    const loading = useSnapshotsStore.getState().load('r1');
    await useSnapshotsStore.getState().remove('r1');
    resolveRead(ok(present('{"a":1}')));
    await loading;
    expect(useSnapshotsStore.getState().entries['r1']).toEqual({ status: 'none' });
  });

  it("drops a save's answer that lands after a newer remove", async () => {
    let resolveWrite: (value: unknown) => void = () => undefined;
    const write = vi.fn().mockReturnValue(new Promise((resolve) => (resolveWrite = resolve)));
    const remove = vi.fn().mockResolvedValue(ok({ removed: true }));
    installWirebenchApi({ snapshot: { write, remove } });
    const saving = useSnapshotsStore.getState().save('r1', '{"a":1}', 'application/json', []);
    await useSnapshotsStore.getState().remove('r1');
    resolveWrite(ok({ savedAt: '2026-09-22T11:00:00.000Z' }));
    await saving;
    expect(useSnapshotsStore.getState().entries['r1']).toEqual({ status: 'none' });
  });

  it('does not roll a failed setIgnore back over a newer save', async () => {
    useSnapshotsStore.setState({ entries: { r1: present('{"a":1}', ['/old']) }, failed: {} });
    let rejectSetIgnore: (reason: unknown) => void = () => undefined;
    const setIgnore = vi.fn().mockReturnValue(new Promise((_, reject) => (rejectSetIgnore = reject)));
    const write = vi.fn().mockResolvedValue(ok({ savedAt: '2026-09-22T11:00:00.000Z' }));
    installWirebenchApi({ snapshot: { setIgnore, write } });
    const ignoring = useSnapshotsStore.getState().setIgnore('r1', ['/new']);
    await useSnapshotsStore.getState().save('r1', '{"a":2}', 'application/json', ['/new']);
    rejectSetIgnore(new Error('disk full'));
    await ignoring;
    expect(useSnapshotsStore.getState().entries['r1']).toEqual({
      status: 'present',
      snapshot: {
        body: '{"a":2}',
        ignore: ['/new'],
        contentType: 'application/json',
        savedAt: '2026-09-22T11:00:00.000Z',
      },
    });
  });

  it('rolls a failed setIgnore back when nothing newer happened', async () => {
    useSnapshotsStore.setState({ entries: { r1: present('{"a":1}', ['/old']) }, failed: {} });
    installWirebenchApi({ snapshot: { setIgnore: vi.fn().mockRejectedValue(new Error('disk full')) } });
    await useSnapshotsStore.getState().setIgnore('r1', ['/new']);
    expect(useSnapshotsStore.getState().entries['r1']).toEqual(present('{"a":1}', ['/old']));
  });

  it('says so when the read is rejected instead of loading forever', async () => {
    installWirebenchApi({ snapshot: { read: vi.fn().mockRejectedValue(new Error('gone')) } });
    render(<SnapshotPanel requestId="r1" body="{}" contentType="application/json" />);
    expect(await screen.findByText('The snapshot could not be read.')).toBeTruthy();
  });

  it('does not claim a match for a binary response', async () => {
    install(present(''));
    render(<SnapshotPanel requestId="r1" body="" contentType="image/png" binary />);
    expect(await screen.findByText('This response has no text body to compare.')).toBeTruthy();
    expect(screen.queryByText(/Matches the snapshot/)).toBeNull();
  });
});
