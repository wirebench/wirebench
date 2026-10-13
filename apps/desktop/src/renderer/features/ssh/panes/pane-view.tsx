import { useRef } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { resizeSplit } from './pane-actions.js';
import { layoutOf, leaves } from './pane-tree.js';
import type { PaneLeaf, PaneNode, Rect } from './pane-tree.js';
import { SplitDivider } from './split-divider.js';

function percent(n: number): string {
  return `${String(n * 100)}%`;
}

function placed(rect: Rect): CSSProperties {
  return {
    left: percent(rect.x0),
    top: percent(rect.y0),
    width: percent(rect.x1 - rect.x0),
    height: percent(rect.y1 - rect.y0),
  };
}

/**
 * A pane tree laid out: every pane drawn by `renderPane` in its own share of the tab, with a divider on
 * each split's boundary. The panes are siblings keyed by id, so a split, a close or a resize moves them
 * without remounting one — its terminal and session carry on.
 */
export function PaneView({
  tabId,
  node,
  renderPane,
}: {
  readonly tabId: string;
  readonly node: PaneNode;
  readonly renderPane: (pane: PaneLeaf) => ReactNode;
}) {
  const container = useRef<HTMLDivElement>(null);
  const { panes, splits } = layoutOf(node);
  return (
    <div ref={container} className="relative h-full w-full overflow-hidden">
      {leaves(node).map((leaf) => {
        const rect = panes.get(leaf.paneId);
        return rect === undefined ? null : (
          <div key={leaf.paneId} className="absolute min-h-0 min-w-0" style={placed(rect)}>
            {renderPane(leaf)}
          </div>
        );
      })}
      {splits.map((area) => (
        <SplitDivider
          key={area.path.join('') || 'root'}
          area={area}
          container={container}
          onRatio={(ratio) => {
            resizeSplit(tabId, area.path, ratio);
          }}
        />
      ))}
    </div>
  );
}
