// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PROJECT_SETTINGS, REQUEST_PROPERTIES } from './helpers/wire-defaults.js';
import type { ProjectWire } from '../src/shared/wire-types.js';

const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: (event: unknown, payload: unknown) => Promise<unknown>) => {
      handlers.set(name, handler);
    },
  },
}));

const { registerSearchChannels, searchCorpus } = await import('../src/main/ipc/search.js');
type SearchChannelEngine = Parameters<typeof registerSearchChannels>[0];
type SearchChannelProjects = Parameters<typeof registerSearchChannels>[1];

const ALL_SCOPES = { requestBodies: true, headers: true, definitions: true } as const;

function invoke(payload: unknown): Promise<unknown> {
  const handler = handlers.get('search.query');
  if (handler === undefined) {
    throw new Error('search.query was never registered');
  }
  return handler({ sender: {} }, payload);
}

function project(id = 'p1', name = 'Demo'): ProjectWire {
  return {
    id,
    name,
    dir: '/tmp/demo',
    dirty: false,
    interfaces: [
      {
        id: 'if-1',
        name: 'Calculator',
        definitionUrl: 'http://example.test/calc.wsdl',
        targetNamespace: 'http://tempuri.org/',
        soapVersions: ['1.1'],
        services: [],
        operations: [],
        problems: [],
        documentCount: 1,
        slug: 'calculator',
        cacheDefinition: true,
        endpoints: [],
        hydration: 'ready',
      },
    ],
    requests: [
      {
        id: 'req-1',
        interfaceId: 'if-1',
        bindingName: '{http://tempuri.org/}CalculatorSoap',
        operationName: 'Add',
        name: 'Request 1',
        envelopeXml: '<Envelope>\n  <Add/>\n</Envelope>',
        soapVersion: '1.1',
        headers: [{ name: 'X-Trace', value: 'abc-123' }],
        order: 0,
        attachments: [],
        properties: REQUEST_PROPERTIES,
      },
    ],
    properties: {},
    environments: [],
    problems: [],
    settings: PROJECT_SETTINGS,
    keystores: [],
    wssOutgoing: [],
    wssIncoming: [],
  } as unknown as ProjectWire;
}

function engineWith(text: string | undefined): SearchChannelEngine {
  return {
    resultFor: (interfaceId: string) => {
      if (text === undefined) {
        throw new Error(`unknown-interface: ${interfaceId}`);
      }
      return { bundle: { documents: [{ location: 'calc.wsdl', text }] } } as never;
    },
  };
}

/** One open workspace holding exactly these project snapshots, in order. */
const projectsWith = (...snapshots: (ProjectWire | null)[]): SearchChannelProjects => ({
  hosts: () => snapshots.map((snapshot) => ({ snapshot: () => snapshot })),
});

describe('searchCorpus', () => {
  it('is empty with no project open', () => {
    expect(searchCorpus(projectsWith(null), engineWith('x'), ALL_SCOPES)).toEqual([]);
    expect(searchCorpus(projectsWith(), engineWith('x'), ALL_SCOPES)).toEqual([]);
  });

  it('tags every document with the project it came from, across all open projects', () => {
    const corpus = searchCorpus(
      projectsWith(project(), project('p2', 'Billing')),
      engineWith('<wsdl:definitions/>'),
      ALL_SCOPES,
    );

    expect(corpus.map((document) => [document.projectId, document.projectName])).toEqual([
      ['p1', 'Demo'],
      ['p1', 'Demo'],
      ['p1', 'Demo'],
      ['p2', 'Billing'],
      ['p2', 'Billing'],
      ['p2', 'Billing'],
    ]);
  });

  it('collects request bodies, headers and definition documents', () => {
    const corpus = searchCorpus(projectsWith(project()), engineWith('<wsdl:definitions/>'), ALL_SCOPES);

    expect(corpus.map((document) => document.kind)).toEqual(['request-body', 'request-header', 'document']);
    expect(corpus[1]?.text).toBe('X-Trace: abc-123');
    expect(corpus[2]).toMatchObject({ interfaceName: 'Calculator', location: 'calc.wsdl' });
  });

  it('honours the scope toggles', () => {
    const corpus = searchCorpus(projectsWith(project()), engineWith('<wsdl:definitions/>'), {
      requestBodies: true,
      headers: false,
      definitions: false,
    });

    expect(corpus.map((document) => document.kind)).toEqual(['request-body']);
  });

  it('skips an interface whose definition is not loaded rather than failing', () => {
    const corpus = searchCorpus(projectsWith(project()), engineWith(undefined), ALL_SCOPES);

    expect(corpus.map((document) => document.kind)).toEqual(['request-body', 'request-header']);
  });
});

describe('search.query', () => {
  beforeEach(() => {
    handlers.clear();
  });

  it('answers with matches across every scope', async () => {
    registerSearchChannels(engineWith('<wsdl:operation name="Add"/>'), projectsWith(project()));

    const result = (await invoke({ query: 'Add', regex: false, caseSensitive: false, scopes: ALL_SCOPES })) as {
      ok: true;
      value: { matches: { kind: string }[]; truncated: boolean };
    };

    expect(result.ok).toBe(true);
    expect(result.value.matches.map((match) => match.kind)).toEqual(['request-body', 'document']);
  });

  it('finds a header value', async () => {
    registerSearchChannels(engineWith(undefined), projectsWith(project()));

    const result = (await invoke({ query: 'abc-123', regex: false, caseSensitive: false, scopes: ALL_SCOPES })) as {
      ok: true;
      value: { matches: { kind: string; snippet: string }[] };
    };

    expect(result.value.matches[0]).toMatchObject({ kind: 'request-header', snippet: 'X-Trace: abc-123' });
  });

  it('carries the project each match came from, for two open projects', async () => {
    registerSearchChannels(engineWith(undefined), projectsWith(project(), project('p2', 'Billing')));

    const result = (await invoke({ query: 'Add', regex: false, caseSensitive: false, scopes: ALL_SCOPES })) as {
      ok: true;
      value: { matches: { projectId: string; projectName: string; kind: string }[] };
    };

    expect(result.value.matches).toHaveLength(2);
    expect(result.value.matches.map((match) => [match.projectId, match.projectName])).toEqual([
      ['p1', 'Demo'],
      ['p2', 'Billing'],
    ]);
  });

  it('reports an invalid regex as an error envelope rather than throwing', async () => {
    registerSearchChannels(engineWith(undefined), projectsWith(project()));

    const result = (await invoke({ query: '(', regex: true, caseSensitive: false, scopes: ALL_SCOPES })) as {
      ok: false;
      error: { code: string };
    };

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('invalid-regex');
  });
});
