import { useCallback, useEffect, useRef, useState } from 'react';

/** The props a caller spreads onto the element carrying `role="grid"`. */
export interface GridProps {
  readonly onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => void;
}

/** The props a caller spreads onto each element carrying `role="row"`. */
export interface GridRowProps {
  readonly tabIndex: 0 | -1;
  readonly 'data-grid-row': number;
}

export interface GridNavigation {
  /** Index of the row that currently holds the grid's single tab stop. */
  readonly activeRow: number;
  readonly gridProps: GridProps;
  readonly rowProps: (index: number) => GridRowProps;
  /** Moves the tab stop without a keystroke — e.g. after a row was clicked. */
  readonly setActiveRow: (index: number) => void;
}

export interface GridNavigationOptions {
  /**
   * Called with the new row index every time a keystroke moves the tab stop. A grid that also
   * carries a selection (the attachments table) uses this to make selection follow focus.
   */
  readonly onActiveRowChange?: (index: number) => void;
}

/**
 * APG data-grid keyboard behaviour for a static table of rows: the grid is a single tab stop,
 * and Up/Down/Home/End move a roving `tabindex` between its rows (the same model the schema
 * tree from Task 45 uses for its treeitems).
 *
 * Only row-level navigation is modelled. Cell-level (Left/Right) navigation is deliberately
 * left to the browser, because every grid here puts real controls — inputs, selects, buttons —
 * inside its cells, and stealing the arrow keys from a focused text field would be worse for a
 * keyboard user than the extra Tab presses.
 *
 * The convention a grid built on this hook follows (History, Keystores and the environments view
 * and tables are the reference):
 *
 * - The container carries `role="grid"` and an `aria-label`; a `<table>` keeps its native markup
 *   but still says `role="grid"`.
 * - Every row carries `role="row"` and holds nothing but cells: `role="gridcell"` spelled out on
 *   each cell (a `<th>` stays a column or row header), one cell wrapping the whole entry when the
 *   row is a single unit rather than columns.
 * - `aria-rowindex` numbers every row of the grid from 1 in document order — column and group
 *   headers included — against an `aria-rowcount` on the grid, so a virtualised grid reads the
 *   same as a static one.
 * - Only the record rows take part in this hook; headers and an empty message are indexed but
 *   never hold the tab stop. An empty state that is not a row sits outside the grid.
 *
 * @param rowCount - How many rows the grid renders; the active row is clamped to it.
 */
export function useGridNavigation(rowCount: number, options: GridNavigationOptions = {}): GridNavigation {
  const [activeRow, setActiveRow] = useState(0);
  // Held in a ref so a caller may pass an inline closure without re-creating the key handler.
  const onActiveRowChange = useRef(options.onActiveRowChange);
  onActiveRowChange.current = options.onActiveRowChange;
  const containerRef = useRef<HTMLElement | null>(null);
  const pendingFocus = useRef(false);

  // Clamp when rows disappear underneath us (a header removed, a search narrowed the list).
  const clamped = rowCount === 0 ? 0 : Math.min(activeRow, rowCount - 1);
  useEffect(() => {
    if (clamped !== activeRow) {
      setActiveRow(clamped);
    }
  }, [clamped, activeRow]);

  // Focus moves in an effect rather than in the key handler: the row that should receive focus
  // only carries `tabindex=0` after React has re-rendered with the new active index.
  useEffect(() => {
    if (!pendingFocus.current) {
      return;
    }
    pendingFocus.current = false;
    const row = containerRef.current?.querySelector<HTMLElement>(`[data-grid-row="${String(clamped)}"]`);
    row?.focus();
  }, [clamped]);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLElement>): void => {
      containerRef.current = event.currentTarget;
      if (rowCount === 0) {
        return;
      }
      const next =
        event.key === 'ArrowDown'
          ? Math.min(rowCount - 1, clamped + 1)
          : event.key === 'ArrowUp'
            ? Math.max(0, clamped - 1)
            : event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? rowCount - 1
                : undefined;
      if (next === undefined) {
        return;
      }
      // A text field owns Home/End (and a `<select>` owns the arrows) for its own value; only
      // a keystroke aimed at a row — or at the grid container itself, which is where the focus
      // sits before any row has taken it — moves the grid's focus.
      const target = event.target as HTMLElement;
      if (target !== event.currentTarget && target.getAttribute('data-grid-row') === null) {
        return;
      }
      event.preventDefault();
      pendingFocus.current = true;
      setActiveRow(next);
      onActiveRowChange.current?.(next);
    },
    [clamped, rowCount],
  );

  const rowProps = useCallback(
    (index: number): GridRowProps => ({ tabIndex: index === clamped ? 0 : -1, 'data-grid-row': index }),
    [clamped],
  );

  return { activeRow: clamped, gridProps: { onKeyDown }, rowProps, setActiveRow };
}
