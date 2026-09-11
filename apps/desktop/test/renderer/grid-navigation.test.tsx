import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useGridNavigation } from '../../src/renderer/lib/grid-navigation.js';

/** A minimal grid built on the hook, standing in for the real Problems/History/Keystores lists. */
function Grid({ rows, onActiveRowChange }: { rows: number; onActiveRowChange?: (index: number) => void }) {
  const { gridProps, rowProps } = useGridNavigation(rows, onActiveRowChange === undefined ? {} : { onActiveRowChange });
  return (
    <div role="grid" aria-label="Test" data-testid="grid" {...gridProps}>
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} role="row" data-testid={`row-${String(index)}`} {...rowProps(index)}>
          <span role="gridcell">row {index}</span>
        </div>
      ))}
    </div>
  );
}

function tabIndexes(rows: number): number[] {
  return Array.from({ length: rows }, (_, index) => Number(screen.getByTestId(`row-${String(index)}`).tabIndex));
}

describe('useGridNavigation', () => {
  afterEach(() => {
    cleanup();
  });

  it('makes the grid one tab stop, on the first row', () => {
    render(<Grid rows={3} />);
    expect(tabIndexes(3)).toEqual([0, -1, -1]);
  });

  it('moves the tab stop with Up/Down and clamps at both ends', () => {
    render(<Grid rows={3} />);
    const first = screen.getByTestId('row-0');

    fireEvent.keyDown(first, { key: 'ArrowDown' });
    expect(tabIndexes(3)).toEqual([-1, 0, -1]);
    expect(document.activeElement).toBe(screen.getByTestId('row-1'));

    fireEvent.keyDown(screen.getByTestId('row-1'), { key: 'ArrowUp' });
    expect(tabIndexes(3)).toEqual([0, -1, -1]);

    fireEvent.keyDown(screen.getByTestId('row-0'), { key: 'ArrowUp' });
    expect(tabIndexes(3)).toEqual([0, -1, -1]);
  });

  it('jumps to the first and last row with Home and End', () => {
    render(<Grid rows={4} />);
    fireEvent.keyDown(screen.getByTestId('row-0'), { key: 'End' });
    expect(tabIndexes(4)).toEqual([-1, -1, -1, 0]);

    fireEvent.keyDown(screen.getByTestId('row-3'), { key: 'Home' });
    expect(tabIndexes(4)).toEqual([0, -1, -1, -1]);
  });

  it('leaves the keys alone when they were aimed at a control inside a cell', () => {
    render(<Grid rows={3} />);
    fireEvent.keyDown(screen.getByText('row 0'), { key: 'ArrowDown' });
    expect(tabIndexes(3)).toEqual([0, -1, -1]);
  });

  it('takes a keystroke aimed at the grid itself, not only at a row', () => {
    // A grid whose own container holds the focus (the attachments table does) must still move.
    render(<Grid rows={3} />);
    fireEvent.keyDown(screen.getByTestId('grid'), { key: 'ArrowDown' });
    expect(tabIndexes(3)).toEqual([-1, 0, -1]);
  });

  it('reports every move to onActiveRowChange, so selection can follow focus', () => {
    const moves: number[] = [];
    render(
      <Grid
        rows={3}
        onActiveRowChange={(index) => {
          moves.push(index);
        }}
      />,
    );
    fireEvent.keyDown(screen.getByTestId('row-0'), { key: 'ArrowDown' });
    fireEvent.keyDown(screen.getByTestId('row-1'), { key: 'End' });
    expect(moves).toEqual([1, 2]);
  });

  it('clamps the active row when rows disappear', () => {
    const { rerender } = render(<Grid rows={4} />);
    fireEvent.keyDown(screen.getByTestId('row-0'), { key: 'End' });
    expect(tabIndexes(4)).toEqual([-1, -1, -1, 0]);

    rerender(<Grid rows={2} />);
    expect(tabIndexes(2)).toEqual([-1, 0]);
  });
});
