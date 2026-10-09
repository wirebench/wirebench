import { describe, expect, it } from 'vitest';
import { AREAS, areaById, enabledAreaIds, toAreaIds } from '../../src/shared/area-module.js';

describe('area modules', () => {
  it('lists the six areas in rail order', () => {
    expect(AREAS.map((area) => area.id)).toEqual(['explorer', 'environments', 'search', 'history', 'wss', 'ssh']);
    const orders = AREAS.map((area) => area.rail.order);
    expect([...orders].sort((a, b) => a - b)).toEqual(orders);
  });

  it('every area has a title, a rail label and a show command', () => {
    for (const area of AREAS) {
      expect(area.feature.id).toBe(area.id);
      expect(area.copy.title.length).toBeGreaterThan(0);
      expect(area.rail.command.startsWith('view.show')).toBe(true);
    }
  });

  it('a switch turns an area off; unknown switches are ignored', () => {
    expect(enabledAreaIds({ wss: false })).toEqual(['explorer', 'environments', 'search', 'history', 'ssh']);
    expect(enabledAreaIds({ nope: false })).toEqual(AREAS.map((a) => a.id));
    expect(enabledAreaIds({})).toEqual(AREAS.map((a) => a.id));
  });

  it('areaById finds an area and rejects an unknown id', () => {
    expect(areaById('history').rail.label).toBe('History');
    expect(() => areaById('nope' as never)).toThrow(/unknown area/);
  });

  it('toAreaIds drops ids that are not areas', () => {
    expect(toAreaIds(['history', 'nope', 'explorer'])).toEqual(['history', 'explorer']);
  });
});
