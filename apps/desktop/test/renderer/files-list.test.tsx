import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileList } from '../../src/renderer/features/ssh/files/file-list.js';
import type { PaneSort } from '../../src/renderer/features/ssh/files/files-store.js';
import type { SftpEntryWire } from '@wirebench/wire/sftp-wire';

// The shared setup stubs offsetHeight at 600px, so the virtualiser sees a viewport of about 23 rows.

const file = (name: string): SftpEntryWire => ({ name, type: 'file', size: 1, mtime: 0, mode: 0o644 });
const dir = (name: string): SftpEntryWire => ({ name, type: 'dir', size: 0, mtime: 0, mode: 0o755 });

function Harness({
  entries,
  onOpen = vi.fn(),
  onUp = vi.fn(),
  onSelected = vi.fn(),
}: {
  readonly entries: readonly SftpEntryWire[];
  readonly onOpen?: (entry: SftpEntryWire) => void;
  readonly onUp?: () => void;
  readonly onSelected?: (names: readonly string[]) => void;
}) {
  const [selected, setSelected] = useState<readonly string[]>([]);
  const [sort, setSort] = useState<PaneSort>({ column: 'name', descending: false });
  return (
    <FileList
      listKey="/"
      entries={entries}
      selected={selected}
      sort={sort}
      onSort={setSort}
      onSelect={(names) => {
        setSelected(names);
        onSelected(names);
      }}
      onOpen={onOpen}
      onUp={onUp}
    />
  );
}

const selectedNames = () =>
  screen
    .getAllByTestId('files-row')
    .filter((row) => row.getAttribute('aria-selected') === 'true')
    .map((row) => row.dataset['name']);

afterEach(() => {
  cleanup();
});

describe('the file list', () => {
  it('renders a window of rows for a folder of 5 000 entries', () => {
    const entries = Array.from({ length: 5000 }, (_, i) => file(`f${String(i).padStart(4, '0')}`));
    render(<Harness entries={entries} />);
    const rows = screen.getAllByTestId('files-row');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThan(200);
  });

  it('selects with a click, extends with ⇧-click and toggles with ⌘-click', () => {
    render(<Harness entries={[file('a'), file('b'), file('c'), file('d')]} />);
    const row = (name: string) => screen.getAllByTestId('files-row').find((r) => r.dataset['name'] === name);
    fireEvent.click(row('a') as HTMLElement);
    fireEvent.click(row('c') as HTMLElement, { shiftKey: true });
    expect(selectedNames()).toEqual(['a', 'b', 'c']);
    fireEvent.click(row('b') as HTMLElement, { metaKey: true });
    expect(selectedNames()).toEqual(['a', 'c']);
    fireEvent.click(row('d') as HTMLElement);
    expect(selectedNames()).toEqual(['d']);
  });

  it('moves with the arrows, extends with ⇧, and selects all with ⌘A', () => {
    render(<Harness entries={[file('a'), file('b'), file('c')]} />);
    const list = screen.getByTestId('files-list');
    fireEvent.keyDown(list, { key: 'ArrowDown' });
    expect(selectedNames()).toEqual(['b']);
    fireEvent.keyDown(list, { key: 'ArrowDown', shiftKey: true });
    expect(selectedNames()).toEqual(['b', 'c']);
    fireEvent.keyDown(list, { key: 'a', metaKey: true });
    expect(selectedNames()).toEqual(['a', 'b', 'c']);
  });

  it('Enter opens the entry under the cursor; Backspace goes up', () => {
    const onOpen = vi.fn();
    const onUp = vi.fn();
    render(<Harness entries={[dir('src'), file('a')]} onOpen={onOpen} onUp={onUp} />);
    const list = screen.getByTestId('files-list');
    fireEvent.keyDown(list, { key: 'Enter' });
    expect(onOpen).toHaveBeenCalledWith(dir('src'));
    fireEvent.keyDown(list, { key: 'Backspace' });
    expect(onUp).toHaveBeenCalled();
  });

  it('a double click opens', () => {
    const onOpen = vi.fn();
    render(<Harness entries={[dir('src')]} onOpen={onOpen} />);
    fireEvent.doubleClick(screen.getAllByTestId('files-row')[0] as HTMLElement);
    expect(onOpen).toHaveBeenCalledWith(dir('src'));
  });

  it('a header click sorts by that column, a second reverses it', () => {
    render(<Harness entries={[file('a')]} />);
    const size = screen.getByRole('columnheader', { name: 'Size' });
    fireEvent.click(size);
    expect(size.getAttribute('aria-sort')).toBe('ascending');
    fireEvent.click(size);
    expect(size.getAttribute('aria-sort')).toBe('descending');
  });
});
