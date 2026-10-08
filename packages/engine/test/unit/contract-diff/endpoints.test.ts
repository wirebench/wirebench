import { describe, expect, it } from 'vitest';
import { diffEndpoints } from '../../../src/contract-diff/endpoints.js';

describe('diffEndpoints', () => {
  it('reports one removed and one added endpoint as a move', () => {
    expect(diffEndpoints(['http://a', 'http://same'], ['http://b', 'http://same'])).toEqual([
      { kind: 'endpoint-moved', severity: 'breaking', message: 'endpoint http://a moved to http://b' },
    ]);
  });

  it('reports removals as breaking and additions as compatible otherwise', () => {
    expect(diffEndpoints(['http://a', 'http://b'], ['http://c']).map((change) => change.kind)).toEqual([
      'endpoint-removed',
      'endpoint-removed',
      'endpoint-added',
    ]);
    expect(diffEndpoints(['http://a'], ['http://a', 'http://b'])).toEqual([
      { kind: 'endpoint-added', severity: 'compatible', message: 'endpoint http://b added' },
    ]);
    expect(diffEndpoints(['http://a'], ['http://a'])).toEqual([]);
  });
});
