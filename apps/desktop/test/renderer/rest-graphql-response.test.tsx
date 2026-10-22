/**
 * A GraphQL response in the renderer (#77): the chip's wording, the Problems rows a check files and
 * clears, the body markers, and the explorer's `GQL` badge and *New GraphQL request* item.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

vi.mock('../../src/renderer/components/toast.js', () => ({ showToast: vi.fn() }));

import { graphqlResponseMarkerData } from '../../src/renderer/kinds/graphql/response-markers.js';
import { explorerActions } from '../../src/renderer/features/explorer/explorer-actions.js';
import { GraphqlChip } from '../../src/renderer/kinds/graphql/response-chip.js';
import {
  graphqlChip,
  graphqlGroupId,
  recordGraphqlProblems,
} from '../../src/renderer/kinds/graphql/response-problems.js';
import { restExplorer } from '../../src/renderer/kinds/rest/explorer.js';
import { restExplorerTree } from '../../src/renderer/kinds/rest/explorer-tree.js';
import { useProblemsStore } from '../../src/renderer/state/problems.js';
import { useProjectStore } from '../../src/renderer/state/project.js';
import type { GraphqlCheckWire } from '../../src/shared/kinds/graphql/wire.js';
import type { RestRequestWire } from '../../src/shared/kinds/rest/wire.js';

const ERRORS: GraphqlCheckWire = {
  schema: 'checked',
  errors: [
    { message: 'Boom', path: ['boom'], pointer: '/errors/0' },
    { message: 'Again', pointer: '/errors/1' },
  ],
  problems: [{ pointer: '/data/product/price', message: 'Expected a Float' }],
};

afterEach(() => {
  cleanup();
});

describe('the GraphQL chip', () => {
  it('counts errors first, then a mismatch, else says there were none', () => {
    expect(graphqlChip(ERRORS)).toEqual({ label: '2 GraphQL errors', tone: 'danger' });
    expect(graphqlChip({ ...ERRORS, errors: [ERRORS.errors[0]!] })?.label).toBe('1 GraphQL error');
    expect(graphqlChip({ ...ERRORS, errors: [] })).toEqual({ label: 'Schema mismatch', tone: 'warning' });
    expect(graphqlChip({ schema: 'no-schema', errors: [], problems: [] })).toEqual({
      label: 'No GraphQL errors',
      tone: 'success',
    });
  });

  it('is not shown for a response that is not a GraphQL one, or too large to read', () => {
    expect(graphqlChip({ schema: 'not-graphql', errors: [], problems: [] })).toBeUndefined();
    expect(graphqlChip({ schema: 'skipped', errors: [], problems: [] })).toBeUndefined();
    render(
      <p>
        <GraphqlChip check={{ schema: 'not-graphql', errors: [], problems: [] }} />
      </p>,
    );
    expect(screen.queryByTestId('rest-graphql-chip')).toBeNull();
  });

  it('renders its words and tone', () => {
    render(
      <p>
        <GraphqlChip check={ERRORS} />
      </p>,
    );
    const chip = screen.getByTestId('rest-graphql-chip');
    expect(chip.textContent).toBe('2 GraphQL errors');
    expect(chip.getAttribute('data-tone')).toBe('danger');
  });
});

describe('the Problems rows', () => {
  beforeEach(() => {
    useProblemsStore.getState().clear(graphqlGroupId('r1'));
  });

  it('files each error and mismatch under the request, and a new send replaces them', () => {
    recordGraphqlProblems('r1', ERRORS);
    const rows = useProblemsStore.getState().items.filter((item) => item.groupId === graphqlGroupId('r1'));
    expect(rows.map((row) => [row.source, row.severity, row.problem.message, row.problem.location])).toEqual([
      ['graphql', 'error', 'Boom', '/errors/0'],
      ['graphql', 'error', 'Again', '/errors/1'],
      ['graphql', 'warning', 'Expected a Float', '/data/product/price'],
    ]);

    recordGraphqlProblems('r1', { schema: 'checked', errors: [], problems: [] });
    expect(useProblemsStore.getState().items.filter((item) => item.groupId === graphqlGroupId('r1'))).toEqual([]);
  });
});

describe('the body markers', () => {
  it('marks an error and a mismatch where their pointers land', () => {
    const text = '{\n  "errors": [\n    { "message": "Boom" }\n  ]\n}';
    const markers = graphqlResponseMarkerData({ ...ERRORS, errors: [ERRORS.errors[0]!], problems: [] }, text);
    expect(markers).toEqual([expect.objectContaining({ severity: 8, message: 'Boom', startLineNumber: 3 })]);
    expect(graphqlResponseMarkerData(undefined, text)).toEqual([]);
  });
});

describe('the explorer', () => {
  const request = (body: RestRequestWire['body']): RestRequestWire =>
    ({ id: 'r1', apiId: 'a1', name: 'Products', method: 'POST', url: '/graphql', body }) as unknown as RestRequestWire;

  function requestNode(body: RestRequestWire['body']) {
    const [container] = restExplorerTree.containers({
      rest: { apis: [{ id: 'a1', name: 'Shop', order: 0 } as never], folders: [], requests: [request(body)] },
    } as never);
    return container!.node.children![0]!;
  }

  it('marks a GraphQL request, and only that', () => {
    expect(requestNode({ kind: 'graphql', query: '{ a }', variables: '' }).graphql).toBe(true);
    expect(requestNode({ kind: 'none' }).graphql).toBeUndefined();
  });

  it('shows GQL in the gutter, with the method in its title', () => {
    const Gutter = restExplorer.nodes['rest-request']!.Gutter!;
    render(<Gutter node={requestNode({ kind: 'graphql', query: '', variables: '' })} />);
    const badge = screen.getByTestId('method-badge');
    expect(badge.textContent).toBe('GQL');
    expect(badge.getAttribute('title')).toBe('GraphQL (POST) Products');
  });

  it('offers New GraphQL request on an API, which adds a POST with a GraphQL body', async () => {
    const items = restExplorer.nodes.api!.menu!({ id: 'api:a1', kind: 'api', label: 'Shop', apiId: 'a1' });
    const flat = items.flat();
    expect(flat.map((item) => item.key)).toContain('new-graphql-request');

    const addRestRequest = vi.fn().mockResolvedValue('r9');
    const updateRestRequest = vi.fn().mockResolvedValue(undefined);
    useProjectStore.setState({ addRestRequest, updateRestRequest } as never);
    const opened = vi.spyOn(explorerActions, 'openRestRequest');

    explorerActions.newGraphqlRequest('a1');

    await vi.waitFor(() => {
      expect(updateRestRequest).toHaveBeenCalledWith('r9', {
        method: 'POST',
        body: { kind: 'graphql', query: '', variables: '' },
      });
    });
    expect(addRestRequest).toHaveBeenCalledWith('a1', undefined, 'New GraphQL request');
    opened.mockRestore();
  });
});
