import { describe, expect, it } from 'vitest';
import { moveTargets } from '../../src/renderer/features/explorer/move-targets.js';

describe('moveTargets', () => {
  it('lists the API root, then its folders in tree order, nested one level deeper each', () => {
    const targets = moveTargets('api-1', 'Petstore', {
      b: { apiId: 'api-1', name: 'Stores', order: 1 },
      a: { apiId: 'api-1', name: 'Pets', order: 0 },
      c: { apiId: 'api-1', parentId: 'a', name: 'Admin', order: 0 },
      other: { apiId: 'api-2', name: 'Elsewhere', order: 0 },
    });

    expect(targets).toEqual([
      { id: '', label: 'Petstore', depth: 0 },
      { id: 'a', label: 'Pets', depth: 1 },
      { id: 'c', label: 'Admin', depth: 2 },
      { id: 'b', label: 'Stores', depth: 1 },
    ]);
  });
});
