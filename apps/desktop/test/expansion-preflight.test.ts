// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  createInterface,
  createProject,
  createRequest,
  isWirebenchError,
  parseSecretSources,
  resolveScopes,
  secretSourcesHash,
  soapInterfacesOf,
  withSoapInterfaces,
} from '@wirebench/engine';
import type { Environment, Interface, Project } from '@wirebench/engine';
import { preflightRequest, secretSourceContext, secretSourceRefCode } from '../src/main/expansion-preflight.js';

const BINDING = '{http://tempuri.org/}CalculatorSoap';

const environment: Environment = {
  id: 'env-1',
  name: 'Dev',
  slug: 'Dev',
  order: 0,
  endpoints: { Calculator: 'http://dev.test/soap' },
  properties: { who: 'ada' },
  disabledProperties: [],
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
    containers: { soap: [iface] },
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

  it('does not report a ${secret:name} token as unresolved: it resolves at send', () => {
    const project = build();
    const operation = soapInterfacesOf(project)[0]!.operations[0]!;
    const request = {
      ...operation.requests[0]!,
      envelopeXml: '<Add><pw>${secret:soap_pw}</pw><who>${#Env#missing}</who></Add>',
      headers: [{ name: 'X-Key', value: 'Key ${secret:api_key}' }],
    };
    const withTokens: Project = withSoapInterfaces(
      {
        ...project,
      },
      [{ ...soapInterfacesOf(project)[0]!, operations: [{ ...operation, requests: [request] }] }],
    );

    const result = preflightRequest(withTokens, 'req-1', resolveScopes(withTokens, undefined, {}, {}));

    expect(result.unresolved.map((ref) => ref.expr)).toEqual(['${#Env#missing}', '${#Global#nope}']);
  });

  it('warns about a token mapped to an invalid or unapproved source, and not a trusted one', () => {
    const shared = parseSecretSources({
      ok: { kind: 'gcp', secret: 's' },
      bad: { kind: 'vault', path: '-x', field: 'f' },
    }).sources;
    const project = build();
    const operation = soapInterfacesOf(project)[0]!.operations[0]!;
    const request = {
      ...operation.requests[0]!,
      envelopeXml: '<Add>${secret:ok} ${secret:bad} ${secret:plain}</Add>',
      headers: [],
    };
    const withTokens: Project = withSoapInterfaces(
      {
        ...project,
      },
      [{ ...soapInterfacesOf(project)[0]!, operations: [{ ...operation, requests: [request] }] }],
    );
    const scopes = resolveScopes(withTokens, undefined, {}, {});
    const run = (approvedHash: string | undefined) =>
      preflightRequest(withTokens, 'req-1', scopes, undefined, '', undefined, {
        shared,
        local: undefined,
        approvedHash,
      }).unresolved.filter((ref) => ref.scope === 'Secret' || ref.code.startsWith('secret-source'));

    expect(run(undefined).map((ref) => [ref.name, ref.code])).toEqual([
      ['ok', 'secret-source-untrusted'],
      ['bad', 'secret-source-invalid'],
    ]);
    expect(run(secretSourcesHash(shared)).map((ref) => [ref.name, ref.code])).toEqual([
      ['bad', 'secret-source-invalid'],
    ]);
  });

  it('secretSourceRefCode flags only a mapped secret token, and a local entry needs no approval', () => {
    const shared = parseSecretSources({ ok: { kind: 'gcp', secret: 's' } }).sources;
    const ref = (name: string) => ({ scope: 'Secret', name, code: 'missing' as const });
    const untrusted = secretSourceContext({ shared, local: undefined, approvedHash: undefined });
    expect(secretSourceRefCode(ref('ok'), untrusted.sources, untrusted.trusted)).toBe('secret-source-untrusted');
    expect(secretSourceRefCode(ref('plain'), untrusted.sources, untrusted.trusted)).toBeUndefined();
    expect(
      secretSourceRefCode({ scope: 'Env', name: 'ok', code: 'missing' }, untrusted.sources, false),
    ).toBeUndefined();
    const local = secretSourceContext({
      shared: undefined,
      local: { ok: { kind: 'gcp', secret: 's' } },
      approvedHash: undefined,
    });
    expect(secretSourceRefCode(ref('ok'), local.sources, local.trusted)).toBeUndefined();
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
      operations: soapInterfacesOf(project)[0]!.operations,
    });
    const result = preflightRequest(
      { ...project, containers: { ...project.containers, soap: [iface] } },
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

describe('preflightRequest — auth source', () => {
  /** Builds a one-request project whose request/endpoint/interface auth can be varied per case. */
  function withAuth(parts: {
    request?: Interface['auth'];
    endpoint?: Interface['auth'];
    iface?: Interface['auth'];
    authMode?: 'override' | 'complement';
  }): Project {
    const iface: Interface = createInterface('Calculator', {
      id: 'iface-1',
      slug: 'Calculator',
      definitionUrl: 'http://example.test/service.wsdl',
      endpoints: [
        {
          id: 'ep-1',
          name: 'Primary',
          url: 'http://a.test/soap',
          authMode: parts.authMode ?? 'override',
          ...(parts.endpoint !== undefined ? { auth: parts.endpoint } : {}),
        },
      ],
      defaultEndpointId: 'ep-1',
      operations: [
        {
          name: 'Add',
          bindingName: BINDING,
          slug: 'Add',
          order: 0,
          requests: [
            {
              ...createRequest('Request 1', { id: 'req-1', envelopeXml: '<Add/>', soapVersion: '1.1' }),
              endpointId: 'ep-1',
              ...(parts.request !== undefined ? { auth: parts.request } : {}),
            },
          ],
        },
      ],
    });
    const withInterfaceAuth: Interface = parts.iface !== undefined ? { ...iface, auth: parts.iface } : iface;
    return { ...createProject('Demo', { id: 'proj-1' }), containers: { soap: [withInterfaceAuth] } };
  }

  const preflight = (project: Project) => preflightRequest(project, 'req-1', resolveScopes(project, undefined, {}, {}));

  it('reports no auth when nothing is configured at any level', () => {
    expect(preflight(withAuth({})).auth).toEqual({ source: 'none', type: 'none' });
  });

  it('reports the request as the source, without the passwordRef', () => {
    const auth = preflight(
      withAuth({ request: { type: 'basic', username: 'ada', passwordRef: 'ref-1', preemptive: false } }),
    ).auth;
    expect(auth).toEqual({ source: 'request', type: 'basic', username: 'ada', preemptive: false });
    expect(JSON.stringify(auth)).not.toContain('ref-1');
  });

  it('names the endpoint and its mode when the endpoint supplies the credentials', () => {
    expect(preflight(withAuth({ endpoint: { type: 'basic', username: 'end' } })).auth).toEqual({
      source: 'endpoint',
      type: 'basic',
      username: 'end',
      endpointName: 'Primary',
      authMode: 'override',
    });
  });

  it('reports the interface fallback when neither request nor endpoint configures auth', () => {
    expect(preflight(withAuth({ iface: { type: 'basic', username: 'iface' } })).auth).toEqual({
      source: 'interface',
      type: 'basic',
      username: 'iface',
    });
  });

  it('keeps the request as the source under complement, showing the merged credentials', () => {
    expect(
      preflight(
        withAuth({
          request: { type: 'basic', username: 'ada' },
          endpoint: { type: 'basic', preemptive: true },
          authMode: 'complement',
        }),
      ).auth,
    ).toEqual({ source: 'request', type: 'basic', username: 'ada', preemptive: true });
  });

  it("names the endpoint under complement when the request's auth is none and the type came from the endpoint", () => {
    expect(
      preflight(
        withAuth({
          request: { type: 'none' },
          endpoint: { type: 'basic', username: 'end' },
          authMode: 'complement',
        }),
      ).auth,
    ).toEqual({ source: 'endpoint', type: 'basic', username: 'end', endpointName: 'Primary', authMode: 'complement' });
  });

  it('uses the interface default endpoint when the request has no endpointId of its own', () => {
    const iface: Interface = createInterface('Calculator', {
      id: 'iface-1',
      slug: 'Calculator',
      definitionUrl: 'http://example.test/service.wsdl',
      endpoints: [
        {
          id: 'ep-1',
          name: 'Default',
          url: 'http://a.test/soap',
          authMode: 'override',
          auth: { type: 'basic', username: 'def' },
        },
      ],
      defaultEndpointId: 'ep-1',
      operations: [
        {
          name: 'Add',
          bindingName: BINDING,
          slug: 'Add',
          order: 0,
          requests: [createRequest('Request 1', { id: 'req-1', envelopeXml: '<Add/>', soapVersion: '1.1' })],
        },
      ],
    });
    const project = { ...createProject('Demo', { id: 'proj-1' }), containers: { soap: [iface] } };

    const result = preflightRequest(project, 'req-1', resolveScopes(project, undefined, {}, {}));

    expect(result.auth).toEqual({
      source: 'endpoint',
      type: 'basic',
      username: 'def',
      endpointName: 'Default',
      authMode: 'override',
    });
  });
});
