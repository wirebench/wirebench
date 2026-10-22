/**
 * One step of dragging the sidebar's edge inward (#686 E22): it narrows to its minimum and stops
 * there; only a drag that carries on past the minimum by {@link COLLAPSE_PAST_PX} collapses it. A
 * short drag to the left used to shut the sidebar the moment it crossed the minimum.
 *
 * Kept free of the store so the rule reads, and tests, as arithmetic: the caller applies the step.
 */

/** How far past the minimum width, in pixels, a drag must carry on before the panel collapses. */
export const COLLAPSE_PAST_PX = 64;

export interface PanelDragState {
  /** The panel's size, as a percentage of the row. */
  readonly size: number;
  /** How far past the minimum the drag has carried so far in this gesture, in pixels. */
  readonly pastMinPx: number;
}

export type PanelDragStep =
  { readonly kind: 'resize'; readonly size: number; readonly pastMinPx: number } | { readonly kind: 'collapse' };

/**
 * Where a drag of `deltaPx` (negative is inward) leaves a panel in a row `widthPx` wide, bound
 * between `min` and `max` percent. The pointer's position is the panel's edge less whatever it has
 * already gone past the minimum, so dragging back out first uses up that overshoot before the panel
 * grows.
 */
export function panelDragStep(
  state: PanelDragState,
  deltaPx: number,
  widthPx: number,
  min: number,
  max: number,
  collapsePastPx = COLLAPSE_PAST_PX,
): PanelDragStep {
  const toPx = (percent: number): number => (percent / 100) * widthPx;
  const pointerPx = toPx(state.size) - state.pastMinPx + deltaPx;
  const minPx = toPx(min);
  if (pointerPx >= minPx) {
    return { kind: 'resize', size: Math.min(max, (pointerPx / widthPx) * 100), pastMinPx: 0 };
  }
  const pastMinPx = minPx - pointerPx;
  return pastMinPx >= collapsePastPx ? { kind: 'collapse' } : { kind: 'resize', size: min, pastMinPx };
}
