/**
 * The GraphQL body (#77) in the renderer: the language providers answer only for a GraphQL body's
 * own models and map main's answers into Monaco's shapes, and the body tab switches to the kind,
 * shows the schema, fetches it through the request, and offers the document's operations.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';

vi.mock('@monaco-editor/react', async () => await import('../mocks/monaco-editor-react.js'));
vi.mock('../../src/renderer/editor/monaco.js', async () => await import('../mocks/monaco-runtime.js'));
vi.mock('../../src/renderer/components/toast.js', () => ({ showToast: vi.fn() }));

import {
  fakeMonaco,
  fakeMonacoWithMarkers,
  registeredCompletionProviders,
  registeredHoverProviders,
  setMarkers,
} from '../mocks/monaco-editor-react.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';
import {
  clearGraphqlModel,
  graphqlCompletionKindOf,
  refreshGraphqlDiagnostics,
  registerGraphqlLanguageOnce,
  setGraphqlModel,
  toGraphqlMarker,
} from '../../src/renderer/editor/graphql-language.js';
import { BodyTab, type BodySchemaSource } from '../../src/renderer/features/rest-editor/body-tab.js';
import { schemaLabel } from '../../src/renderer/features/rest-editor/graphql-body.js';
import { useProjectStore } from '../../src/renderer/state/project.js';
import type { RestBodyWire, RestRequestPatchWire } from '../../src/shared/kinds/rest/wire.js';

const graphqlDiagnostics = vi.fn();
const graphqlComplete = vi.fn();
const graphqlHover = vi.fn();
const graphqlIntrospect = vi.fn();

registerGraphqlLanguageOnce(fakeMonaco as never);
registerGraphqlLanguageOnce(fakeMonaco as never);

type Provider<K extends string> = Record<K, (model: unknown, position: unknown) => Promise<unknown>>;
const providerFor = (language: string) =>
  registeredCompletionProviders.find((entry) => entry.language === language && graphqlOwned.has(entry.provider))
    ?.provider as Provider<'provideCompletionItems'>;
// The JSON variables provider is told apart from any other JSON provider by registration order: the
// two this module registers are the last GraphQL and JSON ones.
const graphqlOwned = new Set(registeredCompletionProviders.slice(-2).map((entry) => entry.provider));
const hover = registeredHoverProviders.find((entry) => entry.language === 'graphql')
  ?.provider as Provider<'provideHover'>;

/** A model whose word under the caret starts at `wordStart`: Monaco's words never include a quote. */
function model(uri: string, line = '', version = 1, wordStart = 2) {
  return {
    uri: { toString: () => uri },
    getVersionId: () => version,
    isDisposed: () => false,
    getLineContent: () => line,
    getWordUntilPosition: () => ({ startColumn: wordStart, endColumn: wordStart + 1 }),
  };
}

const CONTEXT = { apiId: 'api-1', query: 'query P($id: ID!) { product(id: $id) { name } }', variables: '{"i}' };

beforeEach(() => {
  for (const mock of [graphqlDiagnostics, graphqlComplete, graphqlHover, graphqlIntrospect]) mock.mockReset();
  installWirebenchApi({ request: { graphqlDiagnostics, graphqlComplete, graphqlHover, graphqlIntrospect } });
  setMarkers.length = 0;
  setGraphqlModel('file:///query', 'query', () => CONTEXT);
  setGraphqlModel('file:///variables', 'variables', () => CONTEXT);
});

afterEach(() => {
  clearGraphqlModel('file:///query');
  clearGraphqlModel('file:///variables');
  cleanup();
});

describe('the GraphQL providers', () => {
  it('registers completion for GraphQL and JSON, and hover for GraphQL, once', () => {
    expect(registeredCompletionProviders.slice(-2).map((entry) => entry.language)).toEqual(['graphql', 'json']);
    expect(registeredHoverProviders.filter((entry) => entry.language === 'graphql')).toHaveLength(1);
  });

  it("completes the query from main's answer", async () => {
    graphqlComplete.mockResolvedValue({
      ok: true,
      value: { items: [{ label: 'name', kind: 'field', detail: 'String!', documentation: 'The name' }] },
    });

    const list = (await providerFor('graphql').provideCompletionItems(model('file:///query'), {
      lineNumber: 1,
      column: 3,
    })) as { suggestions: readonly Record<string, unknown>[] };

    expect(graphqlComplete).toHaveBeenCalledWith({ ...CONTEXT, target: 'query', line: 1, column: 3 });
    expect(list.suggestions).toEqual([
      expect.objectContaining({
        label: 'name',
        insertText: 'name',
        detail: 'String!',
        kind: fakeMonaco.languages.CompletionItemKind.Field,
        documentation: { value: 'The name' },
      }),
    ]);
  });

  it("completes a variable's key without doubling a quote already typed", async () => {
    graphqlComplete.mockResolvedValue({
      ok: true,
      value: { items: [{ label: 'id', kind: 'variable', insertText: '"id": ' }] },
    });

    const list = (await providerFor('json').provideCompletionItems(model('file:///variables', '{"i}', 1, 3), {
      lineNumber: 1,
      column: 4,
    })) as { suggestions: readonly { insertText: string }[] };

    expect(list.suggestions[0]?.insertText).toBe('id": ');
  });

  it('answers nothing for a model no GraphQL body holds, or in the wrong role', async () => {
    const position = { lineNumber: 1, column: 1 };
    expect(await providerFor('json').provideCompletionItems(model('file:///other'), position)).toEqual({
      suggestions: [],
    });
    expect(await providerFor('graphql').provideCompletionItems(model('file:///variables'), position)).toEqual({
      suggestions: [],
    });
    expect(graphqlComplete).not.toHaveBeenCalled();
  });

  it("shows main's hover, and none when main has nothing", async () => {
    graphqlHover.mockResolvedValueOnce({ ok: true, value: { markdown: 'A product' } });
    graphqlHover.mockResolvedValueOnce({ ok: true, value: { markdown: null } });
    const position = { lineNumber: 1, column: 25 };

    expect(await hover.provideHover(model('file:///query'), position)).toEqual({ contents: [{ value: 'A product' }] });
    expect(await hover.provideHover(model('file:///query'), position)).toBeNull();
  });

  it('marks both editors and answers the operations', async () => {
    const range = { startLine: 1, startColumn: 2, endLine: 1, endColumn: 2 };
    graphqlDiagnostics.mockResolvedValue({
      ok: true,
      value: {
        query: [{ severity: 'error', message: 'Unknown field', range }],
        variables: [{ severity: 'warning', message: 'Unknown variable', range }],
        operations: ['A', 'B'],
      },
    });
    const query = model('file:///query');
    const variables = model('file:///variables');

    const operations = await refreshGraphqlDiagnostics(
      fakeMonacoWithMarkers as never,
      { query, variables } as never,
      CONTEXT,
    );

    expect(operations).toEqual(['A', 'B']);
    expect(setMarkers.map((entry) => [entry.uri, entry.owner, entry.markers.length])).toEqual([
      ['file:///query', 'wirebench-graphql', 1],
      ['file:///variables', 'wirebench-graphql', 1],
    ]);
  });

  it('drops an answer for text a model no longer holds', async () => {
    let version = 1;
    const query = { ...model('file:///query'), getVersionId: () => version };
    graphqlDiagnostics.mockImplementation(() => {
      version = 2;
      return Promise.resolve({ ok: true, value: { query: [], variables: [], operations: [] } });
    });

    expect(
      await refreshGraphqlDiagnostics(fakeMonacoWithMarkers as never, { query } as never, CONTEXT),
    ).toBeUndefined();
    expect(setMarkers).toEqual([]);
  });

  it('maps severities and kinds, and never gives a marker zero width', () => {
    const marker = toGraphqlMarker(fakeMonaco.MarkerSeverity, {
      severity: 'info',
      message: 'm',
      range: { startLine: 2, startColumn: 5, endLine: 2, endColumn: 5 },
    });
    expect(marker).toMatchObject({ severity: fakeMonaco.MarkerSeverity.Info, startColumn: 5, endColumn: 6 });
    expect(graphqlCompletionKindOf(fakeMonaco.languages.CompletionItemKind as never, 'keyword')).toBe(
      fakeMonaco.languages.CompletionItemKind.Keyword,
    );
  });
});

describe('the GraphQL body kind', () => {
  const noSchema: BodySchemaSource = { load: () => Promise.resolve(null) };

  function Host({
    initial,
    onPatch,
  }: {
    readonly initial: RestBodyWire;
    readonly onPatch?: (patch: RestRequestPatchWire) => void;
  }) {
    const [body, setBody] = useState(initial);
    const [method, setMethod] = useState('GET');
    return (
      <BodyTab
        requestId="r1"
        method={method}
        url="/graphql"
        body={body}
        settings={{}}
        schemaSource={noSchema}
        onChange={(patch) => {
          if (patch.body !== undefined) setBody(patch.body);
          if (patch.method !== undefined) setMethod(patch.method);
          onPatch?.(patch);
        }}
      />
    );
  }

  beforeEach(() => {
    graphqlDiagnostics.mockResolvedValue({ ok: true, value: { query: [], variables: [], operations: [] } });
    useProjectStore.setState({
      apis: { 'api-1': { id: 'api-1', name: 'Shop' } as never },
      restRequests: { r1: { id: 'r1', apiId: 'api-1' } as never },
    });
  });

  it('turns a GET into a POST when switched to GraphQL', async () => {
    const patches: RestRequestPatchWire[] = [];
    render(<Host initial={{ kind: 'none' }} onPatch={(patch) => patches.push(patch)} />);

    await userEvent.selectOptions(screen.getByTestId('rest-body-kind'), 'graphql');

    expect(patches).toEqual([{ body: { kind: 'graphql', query: '', variables: '' }, method: 'POST' }]);
    expect(screen.getByLabelText('GraphQL query')).toBeTruthy();
    expect(screen.getByLabelText('GraphQL variables')).toBeTruthy();
    expect(screen.getByTestId('rest-graphql-schema').textContent).toBe('No schema');
  });

  it('fetches the schema through the request, for its API', async () => {
    graphqlIntrospect.mockResolvedValue({ ok: true, value: { source: 'x', fetchedAt: '2026-10-13T00:00:00Z' } });
    render(<Host initial={{ kind: 'graphql', query: '{ ping }', variables: '' }} />);

    await userEvent.click(screen.getByTestId('rest-graphql-fetch'));

    expect(graphqlIntrospect).toHaveBeenCalledWith({ requestId: 'r1', apiId: 'api-1' });
  });

  it("offers the document's operations once there is more than one, and sets the one picked", async () => {
    graphqlDiagnostics.mockResolvedValue({ ok: true, value: { query: [], variables: [], operations: ['A', 'B'] } });
    const patches: RestRequestPatchWire[] = [];
    render(
      <Host
        initial={{ kind: 'graphql', query: 'query A { a } query B { b }', variables: '' }}
        onPatch={(patch) => patches.push(patch)}
      />,
    );

    const picker = await screen.findByTestId('rest-graphql-operation', {}, { timeout: 2000 });
    await userEvent.selectOptions(picker, 'B');

    expect(patches.at(-1)).toEqual({
      body: { kind: 'graphql', query: 'query A { a } query B { b }', variables: '', operationName: 'B' },
    });
    await waitFor(() => {
      expect(graphqlDiagnostics).toHaveBeenLastCalledWith(expect.objectContaining({ operationName: 'B' }));
    });
  });

  it('offers the same escaping a raw JSON body has', async () => {
    const patches: RestRequestPatchWire[] = [];
    render(<Host initial={{ kind: 'graphql', query: '', variables: '' }} onPatch={(patch) => patches.push(patch)} />);

    await userEvent.click(screen.getByTestId('rest-body-escape'));

    expect(patches).toEqual([{ settings: { escapeProperties: true } }]);
  });

  it('labels the schema by where it came from', () => {
    expect(schemaLabel(undefined)).toBe('No schema');
    expect(schemaLabel({ source: 'schema.graphql', fetchedAt: 'not a date' })).toBe('Schema from schema.graphql');
  });
});
