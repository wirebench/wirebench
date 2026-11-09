import { describe, expect, it } from 'vitest';
import { emptyHint, primaryNewItem } from '../../src/renderer/features/explorer/row-actions.js';
import type { ExplorerNode } from '../../src/renderer/features/explorer/tree-nodes.js';

function node(patch: Partial<ExplorerNode> & Pick<ExplorerNode, 'kind'>): ExplorerNode {
  return { id: 'n1', label: 'Node', ...patch };
}

describe('a container row’s own New', () => {
  it('is the first New its menu offers: a request in an API or folder, an API in a project', () => {
    expect(primaryNewItem(node({ kind: 'api', apiId: 'a1', children: [] }))?.label).toBe('New request');
    expect(primaryNewItem(node({ kind: 'folder', apiId: 'a1', folderId: 'f1', children: [] }))?.label).toBe(
      'New request',
    );
    expect(primaryNewItem(node({ kind: 'project', projectId: 'p1', children: [] }))?.label).toBe('New REST API…');
    expect(primaryNewItem(node({ kind: 'webhooks', canEdit: true, children: [] }))?.label).toBe('New catch URL…');
  });

  it('is nothing on a row that is not a container, or where the role may not create', () => {
    expect(primaryNewItem(node({ kind: 'rest-request', apiId: 'a1', requestId: 'r1' }))).toBeUndefined();
    expect(primaryNewItem(node({ kind: 'webhooks', canEdit: false, children: [] }))).toBeUndefined();
  });
});

describe('an empty container’s hint', () => {
  it('names what is missing and the New that adds it', () => {
    const hint = emptyHint(node({ kind: 'api', apiId: 'a1', children: [] }));
    expect(hint?.text).toBe('No requests yet');
    expect(hint?.action?.label).toBe('New request');
    expect(emptyHint(node({ kind: 'webhooks', canEdit: true, children: [] }))?.action?.label).toBe('New catch URL…');
    // A viewer is told the inbox is empty, and offered nothing it may not do.
    expect(emptyHint(node({ kind: 'webhooks', canEdit: false, children: [] }))).toEqual({ text: 'No catch URLs yet' });
  });

  it('is nothing on a container with children, or on a leaf', () => {
    expect(emptyHint(node({ kind: 'api', apiId: 'a1', children: [node({ kind: 'rest-request' })] }))).toBeUndefined();
    expect(emptyHint(node({ kind: 'operation' }))).toBeUndefined();
  });
});
