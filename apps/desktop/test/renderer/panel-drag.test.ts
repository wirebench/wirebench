import { describe, expect, it } from 'vitest';
import { COLLAPSE_PAST_PX, panelDragStep } from '../../src/renderer/shell/panel-drag.js';

/** A row 1000 px wide, so one percent is ten pixels; the sidebar's bounds are 12 % and 40 %. */
const step = (size: number, pastMinPx: number, deltaPx: number) =>
  panelDragStep({ size, pastMinPx }, deltaPx, 1000, 12, 40);

describe('panelDragStep (#686 E22)', () => {
  it('resizes freely between the bounds, capped at the maximum', () => {
    expect(step(20, 0, -50)).toEqual({ kind: 'resize', size: 15, pastMinPx: 0 });
    expect(step(38, 0, 100)).toEqual({ kind: 'resize', size: 40, pastMinPx: 0 });
  });

  it('stops at the minimum and counts how far past it the drag has gone', () => {
    expect(step(15, 0, -50)).toEqual({ kind: 'resize', size: 12, pastMinPx: 20 });
    expect(step(12, 20, -30)).toEqual({ kind: 'resize', size: 12, pastMinPx: 50 });
  });

  it('collapses only once the drag carries on past the threshold', () => {
    expect(step(12, 50, -(COLLAPSE_PAST_PX - 51))).toEqual({
      kind: 'resize',
      size: 12,
      pastMinPx: COLLAPSE_PAST_PX - 1,
    });
    expect(step(12, 50, -(COLLAPSE_PAST_PX - 50))).toEqual({ kind: 'collapse' });
  });

  it('uses up the overshoot before growing again when the drag turns back', () => {
    expect(step(12, 40, 30)).toEqual({ kind: 'resize', size: 12, pastMinPx: 10 });
    const grown = step(12, 40, 60);
    expect(grown).toMatchObject({ kind: 'resize', pastMinPx: 0 });
    expect(grown.kind === 'resize' ? grown.size : undefined).toBeCloseTo(14);
  });
});
