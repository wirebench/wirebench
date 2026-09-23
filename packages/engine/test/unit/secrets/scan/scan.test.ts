import { describe, expect, it } from 'vitest';
import { createInterface, createProject, createRequest } from '../../../../src/project/model.js';
import type { Project } from '../../../../src/project/model.js';
import { createApi, createFolder, createRestRequest, entry as kv } from '../../../../src/rest/model.js';
import { createGrpcApi, createGrpcRequest } from '../../../../src/grpc/model.js';
import { createWsApi, createWsRequest, createWsSavedMessage } from '../../../../src/ws/model.js';
import { maskedPreview, scanProjectForSecrets } from '../../../../src/secrets/scan/scan.js';

const GH = 'ghp_FAKEFAKEFAKEFAKEFAKEFAKEFAKE1234';
const AWS = 'AKIAFAKEFAKEFAKEFAKE';

function project(patch: Partial<Project>): Project {
  return { ...createProject('P', { id: 'p1' }), ...patch };
}

function only(p: Project) {
  const findings = scanProjectForSecrets(p);
  expect(findings).toHaveLength(1);
  const f = findings[0]!;
  return { ...f, stored: f.value };
}

describe('scanProjectForSecrets locations', () => {
  it('project property', () => {
    const f = only(project({ properties: { password: 'changeme', user: 'bob' } }));
    expect(f.location).toEqual({ kind: 'project-property', name: 'password' });
    expect(f).toMatchObject({
      rule: 'sensitive-name',
      label: 'P › property password',
      valueStart: 0,
      valueEnd: 8,
      value: 'changeme',
    });
  });

  it('environment property', () => {
    const env = {
      id: 'e1',
      name: 'Staging',
      slug: 'staging',
      order: 0,
      endpoints: {},
      properties: { k: GH },
      disabledProperties: [],
    };
    const f = only(project({ environments: [env] }));
    expect(f.location).toEqual({ kind: 'env-property', environmentId: 'e1', name: 'k' });
    expect(f.rule).toBe('vendor-token');
    expect(f.label).toBe('Environment Staging › property k');
  });

  it('soap header and envelope', () => {
    const envelope = `<Envelope><Body><Login><password>FAKEpw</password></Login></Body></Envelope>`;
    const req = createRequest('Login 1', {
      id: 's1',
      soapVersion: '1.1',
      envelopeXml: envelope,
      headers: [{ name: 'Authorization', value: 'Bearer abc123def456ghi789' }],
    });
    const iface = createInterface('Billing', {
      definitionUrl: 'x.wsdl',
      operations: [{ name: 'Login', bindingName: 'B', slug: 'login', order: 0, requests: [req] }],
    });
    const findings = scanProjectForSecrets(project({ interfaces: [iface] }));
    expect(findings.map((f) => [f.location, f.rule, f.value])).toEqual([
      [{ kind: 'soap-header', requestId: 's1', name: 'Authorization', index: 0 }, 'bearer', 'abc123def456ghi789'],
      [{ kind: 'soap-body', requestId: 's1' }, 'sensitive-name', 'FAKEpw'],
    ]);
    expect(findings[0]!.label).toBe('Billing › Login › Login 1 › header Authorization');
    expect(envelope.slice(findings[1]!.valueStart, findings[1]!.valueEnd)).toBe('FAKEpw');
  });

  it('rest url, query, headers, raw body and form fields, inside folders', () => {
    const url = `https://h/x?api_key=FAKEkey&page=2`;
    const r = createRestRequest('GET /invoices', {
      id: 'r1',
      url,
      query: [kv('page', '1'), kv('access_token', 'FAKEtok')],
      headers: [kv('Accept', 'json'), kv('X-Api-Key', AWS)],
      body: { kind: 'raw', language: 'json', text: '{"password":"changeme"}' },
    });
    const r2 = createRestRequest('Token', {
      id: 'r2',
      body: { kind: 'form', fields: [kv('grant_type', 'x'), kv('client_secret', 'FAKEsecret')] },
    });
    const api = createApi('Billing API', { requests: [r], folders: [createFolder('Auth', { requests: [r2] })] });
    const findings = scanProjectForSecrets(project({ apis: [api] }));
    expect(findings.map((f) => [f.location, f.rule, f.value, f.label])).toEqual([
      [{ kind: 'rest-url', requestId: 'r1' }, 'sensitive-name', 'FAKEkey', 'Billing API › GET /invoices › URL'],
      [
        { kind: 'rest-query', requestId: 'r1', name: 'access_token', index: 1 },
        'sensitive-name',
        'FAKEtok',
        'Billing API › GET /invoices › query access_token',
      ],
      [
        { kind: 'rest-header', requestId: 'r1', name: 'X-Api-Key', index: 1 },
        'aws-key',
        AWS,
        'Billing API › GET /invoices › header X-Api-Key',
      ],
      [{ kind: 'rest-body', requestId: 'r1' }, 'sensitive-name', 'changeme', 'Billing API › GET /invoices › body'],
      [
        { kind: 'rest-body', requestId: 'r2', field: 1, name: 'client_secret' },
        'sensitive-name',
        'FAKEsecret',
        'Billing API › Auth › Token › body field client_secret',
      ],
    ]);
    expect(url.slice(findings[0]!.valueStart, findings[0]!.valueEnd)).toBe('FAKEkey');
  });

  it('grpc metadata and message', () => {
    const g = createGrpcRequest('Get', {
      id: 'g1',
      metadata: [kv('authorization', 'Bearer abc123def456ghi789')],
      message: `{"token": "${GH}"}`,
    });
    const findings = scanProjectForSecrets(project({ grpcApis: [createGrpcApi('Svc', { requests: [g] })] }));
    expect(findings.map((f) => [f.location, f.rule])).toEqual([
      [{ kind: 'grpc-metadata', requestId: 'g1', name: 'authorization', index: 0 }, 'bearer'],
      [{ kind: 'grpc-message', requestId: 'g1' }, 'vendor-token'],
    ]);
  });

  it('ws headers and text messages', () => {
    const w = createWsRequest('Chat', {
      id: 'w1',
      headers: [kv('Cookie', 'sid=FAKE')],
      messages: [
        createWsSavedMessage('hello', { id: 'm1', content: `{"password":"changeme"}` }),
        createWsSavedMessage('bin', { id: 'm2', format: 'binary', content: GH }),
      ],
    });
    const findings = scanProjectForSecrets(project({ wsApis: [createWsApi('Chat API', { requests: [w] })] }));
    expect(findings.map((f) => [f.location, f.rule, f.value])).toEqual([
      [{ kind: 'ws-header', requestId: 'w1', name: 'Cookie', index: 0 }, 'sensitive-name', 'sid=FAKE'],
      [{ kind: 'ws-message', requestId: 'w1', messageId: 'm1' }, 'sensitive-name', 'changeme'],
    ]);
  });

  it('ws request URL and query table', () => {
    const url = 'wss://h/socket?token=FAKEtok1&page=2';
    const w = createWsRequest('Chat', { id: 'w1', url, query: [kv('page', '2'), kv('access_token', 'FAKEq')] });
    const findings = scanProjectForSecrets(project({ wsApis: [createWsApi('Chat API', { requests: [w] })] }));
    expect(findings.map((f) => [f.location, f.rule, f.value, f.label])).toEqual([
      [{ kind: 'ws-url', requestId: 'w1' }, 'sensitive-name', 'FAKEtok1', 'Chat API › Chat › URL'],
      [
        { kind: 'ws-query', requestId: 'w1', name: 'access_token', index: 1 },
        'sensitive-name',
        'FAKEq',
        'Chat API › Chat › query access_token',
      ],
    ]);
    expect(url.slice(findings[0]!.valueStart, findings[0]!.valueEnd)).toBe('FAKEtok1');
  });

  it('ws request URL near miss: an ordinary parameter', () => {
    const w = createWsRequest('Chat', { id: 'w1', url: 'ws://h/?page=2', query: [kv('page', '3')] });
    expect(scanProjectForSecrets(project({ wsApis: [createWsApi('Chat API', { requests: [w] })] }))).toEqual([]);
  });

  it('the password of a URL userinfo, in a REST and a WS URL', () => {
    const r = createRestRequest('R', { id: 'r1', url: 'https://alice:FAKEpass@h/x' });
    const w = createWsRequest('W', { id: 'w1', url: 'wss://bob:FAKEwspw@h/socket' });
    const findings = scanProjectForSecrets(
      project({
        apis: [createApi('A', { requests: [r, createRestRequest('R2', { id: 'r2', url: 'https://alice@h/x' })] })],
        wsApis: [createWsApi('W', { requests: [w] })],
      }),
    );
    expect(findings.map((f) => [f.location, f.rule, f.value])).toEqual([
      [{ kind: 'rest-url', requestId: 'r1' }, 'url-credentials', 'FAKEpass'],
      [{ kind: 'ws-url', requestId: 'w1' }, 'url-credentials', 'FAKEwspw'],
    ]);
  });

  it('a form field finding carries the field name on its location', () => {
    const r = createRestRequest('Token', {
      id: 'r2',
      body: {
        kind: 'multipart',
        parts: [
          { kind: 'text', ...kv('grant_type', 'x') },
          { kind: 'text', ...kv('client_secret', 'FAKEsecret') },
        ],
      },
    });
    const f = only(project({ apis: [createApi('A', { requests: [r] })] }));
    expect(f.location).toEqual({ kind: 'rest-body', requestId: 'r2', field: 1, name: 'client_secret' });
  });

  it('api-level gRPC metadata and WS headers', () => {
    const g = createGrpcApi('Svc', { id: 'ga' });
    const w = createWsApi('Chat API', { id: 'wa' });
    const findings = scanProjectForSecrets(
      project({
        grpcApis: [{ ...g, metadata: [kv('x-trace', '1'), kv('x-api-key', 'FAKEkey')] }],
        wsApis: [{ ...w, headers: [kv('Authorization', `Token ${GH}`)] }],
      }),
    );
    expect(findings.map((f) => [f.location, f.rule, f.value, f.label])).toEqual([
      [
        { kind: 'grpc-api-metadata', apiId: 'ga', name: 'x-api-key', index: 1 },
        'sensitive-name',
        'FAKEkey',
        'Svc › metadata x-api-key',
      ],
      [
        { kind: 'ws-api-header', apiId: 'wa', name: 'Authorization', index: 0 },
        'vendor-token',
        GH,
        'Chat API › header Authorization',
      ],
    ]);
  });

  it('a project with only references has no findings', () => {
    expect(scanProjectForSecrets(project({ properties: { password: '${secret:pw}' } }))).toEqual([]);
  });
});

describe('finding ids', () => {
  it('are 16 hex chars, stable across calls, and change with the value', () => {
    const a = scanProjectForSecrets(project({ properties: { password: 'changeme' } }))[0]!;
    const b = scanProjectForSecrets(project({ properties: { password: 'changeme' } }))[0]!;
    const c = scanProjectForSecrets(project({ properties: { password: 'changed' } }))[0]!;
    expect(a.id).toMatch(/^[0-9a-f]{16}$/);
    expect(a.id).toBe(b.id);
    expect(c.id).not.toBe(a.id);
  });
  it('are stable across two scans with repeats, and unique across a project', () => {
    const p = project({
      properties: { p: `${GH} x ${GH} y ${GH}`, token: GH },
      apis: [createApi('A', { requests: [createRestRequest('R', { id: 'r1', url: `https://h/?token=${GH}` })] })],
    });
    const a = scanProjectForSecrets(p).map((f) => f.id);
    const b = scanProjectForSecrets(p).map((f) => f.id);
    expect(a).toEqual(b);
    expect(new Set(a).size).toBe(a.length);
    expect(a).toHaveLength(5);
  });
  it('differ for the same value twice in one text', () => {
    const findings = scanProjectForSecrets(project({ properties: { p: `${GH} ${GH}` } }));
    expect(findings).toHaveLength(2);
    expect(findings[0]!.id).not.toBe(findings[1]!.id);
  });
});

describe('maskedPreview', () => {
  it('shows the first 3 characters and the length only', () => {
    expect(maskedPreview(GH)).toBe(`ghp… (${GH.length} chars)`);
    expect(maskedPreview('abc')).toBe('… (3 chars)');
  });
});
