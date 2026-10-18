import { describe, expect, it } from 'vitest';
import {
  quickOpenEntries,
  quickOpenFilter,
  quickOpenKeywords,
  quickOpenKindEntries,
  quickOpenScore,
  quickOpenSnippetEntries,
} from '../../src/renderer/shell/quick-open.js';
import type { SnippetListItemWire } from '../../src/shared/snippets-wire.js';
import type { InterfaceSummary, RequestWire } from '../../src/shared/kinds/soap/wire.js';

const BINDING = '{http://tempuri.org/}CalculatorSoap';

function summary(): InterfaceSummary {
  return {
    id: 'if-1',
    name: 'Calculator',
    definitionUrl: 'http://example.test/calc.wsdl',
    targetNamespace: 'http://tempuri.org/',
    soapVersions: ['1.1'],
    services: [],
    operations: [
      {
        name: 'Add',
        binding: BINDING,
        bindingLocal: 'CalculatorSoap',
        soapVersion: '1.1',
        style: 'document',
        ports: [],
        inputMimeParts: [],
      },
      {
        name: 'Subtract',
        binding: BINDING,
        bindingLocal: 'CalculatorSoap',
        soapVersion: '1.1',
        style: 'document',
        ports: [],
        inputMimeParts: [],
      },
    ],
    problems: [],
    documentCount: 1,
  };
}

function request(): RequestWire {
  return {
    id: 'req-1',
    interfaceId: 'if-1',
    bindingName: BINDING,
    operationName: 'Add',
    name: 'Request 1',
    envelopeXml: '<x/>',
    soapVersion: '1.1',
    headers: [],
    order: 0,
    attachments: [],
    properties: {},
  } as unknown as RequestWire;
}

describe('quickOpenEntries', () => {
  it('lists saved requests first, with an interface › binding › operation breadcrumb', () => {
    const entries = quickOpenEntries({ 'if-1': summary() }, { 'req-1': request() });

    expect(entries[0]?.kind).toBe('request');
    expect(entries[0]?.label).toBe('Request 1');
    expect(entries[0]?.detail).toBe('Calculator › CalculatorSoap › Add');
  });

  it('lists only the operations that have no request yet', () => {
    const entries = quickOpenEntries({ 'if-1': summary() }, { 'req-1': request() });

    expect(entries.filter((entry) => entry.kind === 'operation').map((entry) => entry.label)).toEqual(['Subtract']);
  });

  it('lists every operation when the project has no requests', () => {
    const entries = quickOpenEntries({ 'if-1': summary() }, {});

    expect(entries.map((entry) => entry.label)).toEqual(['Add', 'Subtract']);
  });

  it('carries what creating a request from an operation needs', () => {
    const operation = quickOpenEntries({ 'if-1': summary() }, {})[0];

    expect(operation).toMatchObject({ interfaceId: 'if-1', bindingName: BINDING, operationName: 'Add' });
  });

  it('matches on the breadcrumb as well as the name', () => {
    expect(quickOpenEntries({ 'if-1': summary() }, {})[0]?.value).toContain('Calculator');
  });

  it('gives every entry a unique key', () => {
    const entries = quickOpenEntries({ 'if-1': summary() }, { 'req-1': request() });

    expect(new Set(entries.map((entry) => entry.key)).size).toBe(entries.length);
  });

  it('is empty for an empty project', () => {
    expect(quickOpenEntries({}, {})).toEqual([]);
  });

  it('prefixes each row with the project that owns it, leaving the keys alone', () => {
    const entries = quickOpenEntries(
      { 'if-1': summary() },
      { 'req-1': request() },
      { 'if-1': 'p1', 'req-1': 'p1' },
      { p1: 'Payments' },
    );

    const saved = entries.find((entry) => entry.kind === 'request');
    expect(saved?.key).toBe('request:req-1');
    expect(saved?.label).toBe('Payments › Request 1');
    expect(saved?.detail).toBe('Payments › Calculator › CalculatorSoap › Add');

    const operation = entries.find((entry) => entry.kind === 'operation');
    expect(operation?.key).toBe(`operation:if-1/${BINDING}/Subtract`);
    expect(operation?.label).toBe('Payments › Subtract');
  });

  it('tells two open projects apart', () => {
    const other: InterfaceSummary = { ...summary(), id: 'if-2', name: 'Countries' };
    const entries = quickOpenEntries(
      { 'if-1': summary(), 'if-2': other },
      {},
      { 'if-1': 'p1', 'if-2': 'p2' },
      { p1: 'Payments', p2: 'Geo' },
    );

    expect(entries.map((entry) => entry.label)).toEqual([
      'Geo › Add',
      'Geo › Subtract',
      'Payments › Add',
      'Payments › Subtract',
    ]);
  });
});

describe('quickOpenSnippetEntries', () => {
  const snippet = (over: Partial<SnippetListItemWire>): SnippetListItemWire => ({
    id: 'tail',
    name: 'Tail logs',
    tags: ['logs', 'prod'],
    firstLine: 'tail -f /var/log/syslog',
    literalStart: 'tail -f /var/log/syslog',
    variables: [],
    secrets: [],
    enter: true,
    confirm: false,
    lineCount: 1,
    revision: 'r',
    ...over,
  });

  it('one row per snippet, in list order, matching on name, package, tags and first line', () => {
    const entries = quickOpenSnippetEntries([
      snippet({ packageId: 'ops', packageName: 'Ops' }),
      snippet({ id: 'df', name: 'Disk', tags: [], firstLine: 'df -h' }),
    ]);
    expect(entries).toEqual([
      {
        key: 'snippet:tail',
        kind: 'snippet',
        label: 'Tail logs',
        detail: 'Ops · tail -f /var/log/syslog',
        value: 'Tail logs Ops logs prod tail -f /var/log/syslog',
        snippetId: 'tail',
      },
      { key: 'snippet:df', kind: 'snippet', label: 'Disk', detail: 'df -h', value: 'Disk df -h', snippetId: 'df' },
    ]);
  });
});

describe('quickOpenKindEntries', () => {
  const places = {
    folders: { 'f-outer': { name: 'Pets' }, 'f-inner': { name: 'Admin', parentId: 'f-outer' } },
    projectOf: { 'api-1': 'p-1' },
    projectNames: { 'p-1': 'Shop' },
  };

  it('labels a request METHOD name, with project › API › folders under it', () => {
    const [entry] = quickOpenKindEntries(
      'rest',
      [{ id: 'r-1', tag: 'GET', name: 'List pets', apiId: 'api-1', apiName: 'Petstore', folderId: 'f-inner' }],
      places,
    );

    expect(entry?.label).toBe('GET List pets');
    expect(entry?.detail).toBe('Shop › Petstore › Pets › Admin');
    expect(entry?.kind).toBe('request');
    expect(entry?.requestKind).toBe('rest');
    expect(entry?.requestId).toBe('r-1');
  });

  it('matches on the URL as well as the name', () => {
    const [entry] = quickOpenKindEntries(
      'rest',
      [{ id: 'r-1', tag: 'GET', name: 'One', apiId: 'api-1', apiName: 'Petstore', match: '${base}/pets/{id}' }],
      places,
    );

    expect(entry?.value).toContain('/pets/{id}');
  });

  it('leaves the project out when it is not known, and stops at a folder cycle', () => {
    const [entry] = quickOpenKindEntries(
      'grpc',
      [{ id: 'g-1', tag: 'gRPC', name: 'Say', apiId: 'api-2', apiName: 'Greeter', folderId: 'a' }],
      {
        folders: { a: { name: 'A', parentId: 'b' }, b: { name: 'B', parentId: 'a' } },
        projectOf: {},
        projectNames: {},
      },
    );

    expect(entry?.detail).toBe('Greeter › B › A');
    expect(entry?.key).toBe('grpc-request:g-1');
  });

  it('sorts kind requests in among the SOAP requests, ahead of the operations', () => {
    const rest = quickOpenKindEntries(
      'rest',
      [{ id: 'r-1', tag: 'GET', name: 'List pets', apiId: 'api-1', apiName: 'Petstore' }],
      places,
    );
    const entries = quickOpenEntries({ 'if-1': summary() }, { 'req-1': request() }, {}, {}, rest);

    expect(entries.map((entry) => entry.label)).toEqual(['GET List pets', 'Request 1', 'Subtract']);
  });
});

describe('quickOpenScore', () => {
  const petstore = quickOpenKindEntries(
    'rest',
    [
      { id: 'find', tag: 'GET', name: 'Find pets by status', apiId: 'api-1', apiName: 'Swagger Petstore' },
      { id: 'delete', tag: 'DELETE', name: 'Delete user', apiId: 'api-1', apiName: 'Swagger Petstore' },
      {
        id: 'order',
        tag: 'POST',
        name: 'Place order',
        apiId: 'api-1',
        apiName: 'Swagger Petstore',
        match: '/store/order',
      },
    ],
    { folders: {}, projectOf: { 'api-1': 'p-1' }, projectNames: { 'p-1': 'Payments' } },
  );

  /** The rows that match `search`, best first, as the palette lists them. */
  const ranked = (search: string): string[] =>
    petstore
      .map((entry) => ({ entry, score: quickOpenFilter(entry.value, search, quickOpenKeywords(entry)) }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score)
      .map(({ entry }) => entry.label);

  it('ranks a name match above a breadcrumb-only match', () => {
    expect(ranked('pet')).toEqual(['GET Find pets by status', 'DELETE Delete user', 'POST Place order']);
    expect(quickOpenScore('Find pets by status', 'Swagger Petstore', 'pet')).toBeGreaterThan(0.5);
    expect(quickOpenScore('Delete user', 'Swagger Petstore', 'pet')).toBeLessThan(0.5);
  });

  it('lists a breadcrumb-only match only when every typed word is missing from the name', () => {
    expect(ranked('petstore delete')).toEqual([]);
    expect(quickOpenScore('Delete user', 'Swagger Petstore', 'swagger payments')).toBe(0);
    expect(quickOpenScore('Delete user', 'Payments › Swagger Petstore', 'swagger payments')).toBeGreaterThan(0);
  });

  it('needs each word of a breadcrumb match as typed, not spread over the path', () => {
    expect(quickOpenScore('Delete user', 'Payments › Swagger Petstore', 'pmts')).toBe(0);
    expect(ranked('/store/order')).toEqual(['POST Place order']);
  });

  it('matches a name fuzzily, with its method', () => {
    expect(ranked('get fnd')).toEqual(['GET Find pets by status']);
  });

  it("keeps every row for an empty search, and cmdk's own score for a row with no name", () => {
    expect(ranked('  ')).toHaveLength(3);
    expect(quickOpenFilter('api-1 10.0.1.5', '10.0', [])).toBeGreaterThan(0);
  });

  it('names a SOAP request or operation without its project prefix', () => {
    const entries = quickOpenEntries(
      { 'if-1': summary() },
      { 'req-1': request() },
      { 'req-1': 'p1', 'if-1': 'p1' },
      {
        p1: 'Calc Project',
      },
    );

    expect(entries.map((entry) => entry.name)).toEqual(['Request 1', 'Subtract']);
  });
});
