import { describe, expect, it } from 'vitest';
import { nextSelection } from '../../src/renderer/features/console/log-selection.js';

describe('nextSelection', () => {
  it('plain click selects one', () => expect(nextSelection(['a', 'b'], 'c', false)).toEqual(['c']));
  it('additive click adds a second', () => expect(nextSelection(['a'], 'b', true)).toEqual(['a', 'b']));
  it('a third replaces the older', () => expect(nextSelection(['a', 'b'], 'c', true)).toEqual(['b', 'c']));
  it('additive click on one of two removes it', () => expect(nextSelection(['a', 'b'], 'a', true)).toEqual(['b']));
  it('additive click on the only row keeps it', () => expect(nextSelection(['a'], 'a', true)).toEqual(['a']));
});
