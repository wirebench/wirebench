import type { PointerEvent as ReactPointerEvent, RefObject } from 'react';
import type { SplitArea } from './pane-tree.js';

/** How thick the bar is, in pixels; it straddles the boundary over both halves' edges. */
const THICKNESS = 4;

function percent(n: number): string {
  return `${String(n * 100)}%`;
}

/**
 * The bar on a split's boundary. Dragging it sets the first half's share of the split (the tree clamps
 * it to 0.1–0.9); a double-click evens the halves out. The terminals refit on their own as their holders
 * change size.
 */
export function SplitDivider({
  area,
  container,
  onRatio,
}: {
  readonly area: SplitArea;
  /** The element the layout fills, whose size turns the split's share of it into pixels. */
  readonly container: RefObject<HTMLDivElement | null>;
  readonly onRatio: (ratio: number) => void;
}) {
  const { dir, ratio, rect } = area;
  const row = dir === 'row';
  const start = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const element = container.current;
    if (element === null || event.button !== 0) return;
    event.preventDefault();
    const box = element.getBoundingClientRect();
    const origin = row ? box.left + box.width * rect.x0 : box.top + box.height * rect.y0;
    const span = row ? box.width * (rect.x1 - rect.x0) : box.height * (rect.y1 - rect.y0);
    const move = (e: PointerEvent): void => {
      if (span > 0) onRatio(((row ? e.clientX : e.clientY) - origin) / span);
    };
    const end = (): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
  };
  const at = row ? rect.x0 + (rect.x1 - rect.x0) * ratio : rect.y0 + (rect.y1 - rect.y0) * ratio;
  const style = row
    ? {
        left: `calc(${percent(at)} - ${String(THICKNESS / 2)}px)`,
        top: percent(rect.y0),
        height: percent(rect.y1 - rect.y0),
        width: THICKNESS,
      }
    : {
        top: `calc(${percent(at)} - ${String(THICKNESS / 2)}px)`,
        left: percent(rect.x0),
        width: percent(rect.x1 - rect.x0),
        height: THICKNESS,
      };
  return (
    <div
      role="separator"
      aria-orientation={row ? 'vertical' : 'horizontal'}
      aria-label="Resize panes"
      data-testid="ssh-pane-divider"
      className={`absolute z-10 bg-hairline hover:bg-accent ${row ? 'cursor-col-resize' : 'cursor-row-resize'}`}
      style={style}
      onPointerDown={start}
      onDoubleClick={() => {
        onRatio(0.5);
      }}
    />
  );
}
