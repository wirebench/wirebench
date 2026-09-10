// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createInterface, createProject, createRequest, isWirebenchError, resolveScopes } from '@wirebench/engine';
import type { Environment, Interface, Project } from '@wirebench/engine';
import { preflightRequest } from '../src/main/expansion-preflight.js';

const BINDING = '{http://tempuri.org/}CalculatorSoap';

const environment: Environment = {
  id: 'env-1',
  name: 'Dev',
  slug: 'Dev',
  order: 0,
  endpoints: { Calculator: 'http://dev.test/soap' },
  properties: { who: 'ada' },
};

function build(): Project {
  const iface: Interface = createInterface('Calculator', {
    id: 'iface-1',
    slug: 'Calculator',
    definitionUrl: 'http://example.test/service.wsdl',
    endpoints: [{ id: 'ep-1', name: 'Primary', url: 'http://a.test/${#Project#stage}', authMode: 'complement' }],
    defaultEndpointId: 'ep-1',
    operations: [
      {
        name: 'Add',
        bindingName: BINDING,
        slug: 'Add',
        order: 0,
        requests: [
          createRequest('Request 1', {
            id: 'req-1',
            envelopeXml: '<Add><who>${#Env#missing}</who></Add>',
            soapVersion: '1.1',
            soapAction: 'urn:${#Global#nope}',
            headers: [{ name: 'X-User', value: '${who}' }],
          }),
        ],
      },
    ],
  });
  return {
    ...createProject('Demo', { id: 'proj-1' }),
    interfaces: [iface],
    environments: [environment],
    properties: { stage: 'soap' },
  };
}

describe('preflightRequest', () => {
  it('resolves the endpoint through the interface default and expands every field', () => {
    const project = build();
    const scopes = resolveScopes(project, undefined, {}, {});

    const result = preflightRequest(project, 'req-1', scopes);

    expect(result).toMatchObject({ endpoint: 'http://a.test/${#Project#stage}', endpointSource: 'interface-default' });
    expect(result.unresolved.map((ref) => [ref.field, ref.expr, ref.headerName])).toEqual([
      ['envelopeXml', '${#Env#missing}', undefined],
      ['soapAction', '${#Global#nope}', undefined],
      ['header', '${who}', 'X-User'],
    ]);
    expect(result.unresolved[0]).toMatchObject({ scope: 'Env', name: 'missing', code: 'missing' });
  });

  it("prefers the active environment's endpoint override for the interface slug", () => {
    const project = { ...build(), activeEnvironmentId: 'env-1' };
    const scopes = resolveScopes(project, 'env-1', {}, {});

    const result = preflightRequest(project, 'req-1', scopes, 'env-1');

    expect(result).toMatchObject({ endpoint: 'http://dev.test/soap', endpointSource: 'environment' });
    // `${who}` now resolves from the environment; only the two explicitly-scoped refs remain.
    expect(result.unresolved.map((ref) => ref.field)).toEqual(['envelopeXml', 'soapAction']);
  });

  it('reports an unresolved reference in the endpoint itself', () => {
    const project = build();
    const scopes = resolveScopes(project, undefined, {}, {});
    const withoutStage = { ...project, properties: {} };

    const result = preflightRequest(withoutStage, 'req-1', { ...scopes, project: {} });

    expect(result.unresolved[0]).toMatchObject({ field: 'endpoint', expr: '${#Project#stage}' });
  });

  it('reports no endpoint when the interface has none', () => {
    const project = build();
    const iface: Interface = createInterface('Calculator', {
      id: 'iface-1',
      slug: 'Calculator',
      definitionUrl: 'http://example.test/service.wsdl',
      operations: project.interfaces[0]!.operations,
    });
    const result = preflightRequest(
      { ...project, interfaces: [iface] },
      'req-1',
      resolveScopes(project, undefined, {}, {}),
    );

    expect(result.endpoint).toBeUndefined();
    expect(result.endpointSource).toBe('none');
  });

  it('rejects an unknown request id', () => {
    const project = build();
    const scopes = resolveScopes(project, undefined, {}, {});
    let thrown: unknown;
    try {
      preflightRequest(project, 'nope', scopes);
    } catch (error) {
      thrown = error;
    }
    expect(isWirebenchError(thrown) && thrown.code).toBe('not-found');
  });
});
