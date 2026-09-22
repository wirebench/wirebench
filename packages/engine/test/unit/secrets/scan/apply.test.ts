import { describe, expect, it } from 'vitest';
import { createInterface, createProject, createRequest } from '../../../../src/project/model.js';
import type { Project } from '../../../../src/project/model.js';
import { createApi, createRestRequest, entry as kv } from '../../../../src/rest/model.js';
import { createGrpcApi, createGrpcRequest } from '../../../../src/grpc/model.js';
import { createWsApi, createWsRequest, createWsSavedMessage } from '../../../../src/ws/model.js';
import { projectFiles } from '../../../../src/project/serialize.js';
import { scanProjectForSecrets } from '../../../../src/secrets/scan/scan.js';
import { applySecretMoves, proposeSecretName } from '../../../../src/secrets/scan/apply.js';
import { expand } from '../../../../src/project/properties.js';
import type { SecretFinding } from '../../../../src/secrets/scan/walk.js';

const GH = 'ghp_FAKEFAKEFAKEFAKEFAKEFAKEFAKE1234';
const AWS = 'AKIAFAKEFAKEFAKEFAKE';

function project(patch: Partial<Project>): Project {
  return { ...createProject('P', { id: 'p1' }), ...patch };
}

function moveAll(p: Project, name = (_f: SecretFinding, i: number) => `s${i}`) {
  const findings = scanProjectForSecrets(p);
  return {
    findings,
    ...applySecretMoves(
      p,
      findings.map((finding, i) => ({ finding, name: name(finding, i) })),
    ),
  };
}

function restProject(req: Parameters<typeof createRestRequest>[1]): Project {
  return project({ apis: [createApi('A', { requests: [createRestRequest('R', { id: 'r1', ...req })] })] });
}

describe('applySecretMoves', () => {
  it('replaces only the credential part of a header', () => {
    const p = restProject({ headers: [kv('Authorization', 'Bearer abc123def456ghi789')] });
    const r = moveAll(p, () => 'n');
    expect(r.stale).toEqual([]);
    expect(r.project.apis[0]!.requests[0]!.headers[0]!.value).toBe('Bearer ${secret:n}');
    expect(r.values).toEqual({ [r.findings[0]!.id]: 'abc123def456ghi789' });
  });

  it('does not mutate the input and shares untouched branches', () => {
    const p = project({
      properties: { password: 'changeme' },
      apis: [createApi('A', { requests: [createRestRequest('R', { id: 'r1' })] })],
    });
    const before = JSON.stringify(p);
    const r = moveAll(p);
    expect(JSON.stringify(p)).toBe(before);
    expect(r.project).not.toBe(p);
    expect(r.project.properties).toEqual({ password: '${secret:s0}' });
    expect(r.project.apis).toBe(p.apis);
    expect(applySecretMoves(p, []).project).toBe(p);
  });

  it('applies two findings in one body right to left', () => {
    const text = `{"password":"changeme","token":"${GH}"}`;
    const r = moveAll(restProject({ body: { kind: 'raw', language: 'json', text } }));
    expect(r.findings).toHaveLength(2);
    const body = r.project.apis[0]!.requests[0]!.body;
    expect(body).toMatchObject({ text: '{"password":"${secret:s0}","token":"${secret:s1}"}' });
  });

  it('stores a JSON-escaped body value raw', () => {
    const text = '{"password":"a\\"b\\u0041c"}';
    const r = moveAll(restProject({ body: { kind: 'raw', language: 'json', text } }));
    expect(r.findings[0]!.value).toBe('a\\"b\\u0041c');
    expect(Object.values(r.values)).toEqual(['a\\"b\\u0041c']);
  });

  it('stores an XML-escaped envelope value raw', () => {
    const envelope = '<E><password>p&amp;w&#33;</password></E>';
    const req = createRequest('R', { id: 's1', soapVersion: '1.1', envelopeXml: envelope });
    const iface = createInterface('I', {
      definitionUrl: 'x.wsdl',
      operations: [{ name: 'O', bindingName: 'B', slug: 'o', order: 0, requests: [req] }],
    });
    const r = moveAll(project({ interfaces: [iface] }));
    expect(r.project.interfaces[0]!.operations[0]!.requests[0]!.envelopeXml).toBe(
      '<E><password>${secret:s0}</password></E>',
    );
    expect(Object.values(r.values)).toEqual(['p&amp;w&#33;']);
  });

  it('rewrites a URL parameter and a query-table entry each in its own place, storing the URL text raw', () => {
    const r = moveAll(
      restProject({ url: 'https://h/x?api_key=FAKE%2Bkey+1&p=2', query: [kv('access_token', 'FAKEtok')] }),
    );
    expect(r.stale).toEqual([]);
    const req = r.project.apis[0]!.requests[0]!;
    expect(req.url).toBe('https://h/x?api_key=${secret:s0}&p=2');
    expect(req.query[0]!.value).toBe('${secret:s1}');
    expect(r.values[r.findings[0]!.id]).toBe('FAKE%2Bkey+1');
    expect(r.values[r.findings[1]!.id]).toBe('FAKEtok');
  });

  it('rewrites form fields, env properties, grpc and ws locations', () => {
    const env = {
      id: 'e1',
      name: 'S',
      slug: 's',
      order: 0,
      endpoints: {},
      properties: { k: GH },
      disabledProperties: [],
    };
    const g = createGrpcRequest('G', { id: 'g1', metadata: [kv('x-api-key', 'FAKEkey')], message: `{"t":"${GH}"}` });
    const w = createWsRequest('W', {
      id: 'w1',
      headers: [kv('Cookie', 'sid=FAKE')],
      messages: [createWsSavedMessage('m', { id: 'm1', content: '{"password":"changeme"}' })],
    });
    const p = project({
      environments: [env],
      apis: [
        createApi('A', {
          requests: [
            createRestRequest('R', { id: 'r1', body: { kind: 'form', fields: [kv('client_secret', 'FAKEs')] } }),
          ],
        }),
      ],
      grpcApis: [{ ...createGrpcApi('G', { id: 'ga', requests: [g] }), metadata: [kv('x-api-key', AWS)] }],
      wsApis: [{ ...createWsApi('W', { id: 'wa', requests: [w] }), headers: [kv('Authorization', `Token ${GH}`)] }],
    });
    const r = moveAll(p);
    expect(r.stale).toEqual([]);
    expect(scanProjectForSecrets(r.project)).toEqual([]);
    expect(Object.keys(r.values)).toHaveLength(r.findings.length);
  });

  it('skips a finding whose value changed and reports it stale', () => {
    const p = project({ properties: { password: 'changeme', token: GH } });
    const findings = scanProjectForSecrets(p);
    const edited = { ...p, properties: { ...p.properties, password: 'changed!' } };
    const r = applySecretMoves(
      edited,
      findings.map((finding, i) => ({ finding, name: `s${i}` })),
    );
    const pw = findings.find((f) => f.location.kind === 'project-property' && f.location.name === 'password')!;
    expect(r.stale).toEqual([pw.id]);
    expect(r.project.properties.password).toBe('changed!');
    expect(r.project.properties.token).toBe('${secret:s1}');
    expect(r.values[pw.id]).toBeUndefined();
  });

  it('reports a finding whose location is gone or whose name is invalid as stale', () => {
    const p = project({ properties: { password: 'changeme' } });
    const [finding] = scanProjectForSecrets(p);
    expect(applySecretMoves(project({}), [{ finding: finding!, name: 'n' }]).stale).toEqual([finding!.id]);
    expect(applySecretMoves(p, [{ finding: finding!, name: '1bad' }]).stale).toEqual([finding!.id]);
  });

  it('expanding the tokens with the stored values restores the original text byte for byte', () => {
    const json = '{"password":"p\\"w\\u0041","k":"x"}';
    const envelope = '<E><password>a&amp;b</password></E>';
    const req = createRequest('R', { id: 's1', soapVersion: '1.1', envelopeXml: envelope });
    const iface = createInterface('I', {
      definitionUrl: 'x.wsdl',
      operations: [{ name: 'O', bindingName: 'B', slug: 'o', order: 0, requests: [req] }],
    });
    const p = { ...restProject({ body: { kind: 'raw', language: 'json', text: json } }), interfaces: [iface] };
    const r = moveAll(p);
    expect(r.findings).toHaveLength(2);
    const secrets = Object.fromEntries(r.findings.map((f, i) => [`s${i}`, r.values[f.id]!]));
    const body = r.project.apis[0]!.requests[0]!.body as { text: string };
    const env = r.project.interfaces[0]!.operations[0]!.requests[0]!.envelopeXml;
    expect(body.text).not.toBe(json);
    expect(expand(body.text, { project: {}, global: {}, system: {}, secrets }).text).toBe(json);
    expect(expand(env, { project: {}, global: {}, system: {}, secrets }).text).toBe(envelope);
  });

  it('leaves no moved value in any written file', () => {
    const p = restProject({
      url: 'https://h/x?api_key=FAKEkey1',
      headers: [kv('Authorization', 'Bearer abc123def456ghi789')],
      body: { kind: 'raw', language: 'json', text: `{"password":"changeme","k":"${AWS}"}` },
    });
    const r = moveAll({ ...p, properties: { token: GH } });
    const written = [...projectFiles(r.project).values()].join('\n');
    for (const f of r.findings) expect(written).not.toContain(f.value);
    expect(written).toContain('${secret:');
  });
});

describe('proposeSecretName', () => {
  const find = (p: Project) => scanProjectForSecrets(p)[0]!;

  it('uses the header, field or property name, snake-cased', () => {
    expect(proposeSecretName(find(restProject({ headers: [kv('X-Api-Key', AWS)] })), new Set())).toBe('x_api_key');
    expect(proposeSecretName(find(project({ properties: { dbPassword: 'changeme' } })), new Set())).toBe('db_password');
    const form = restProject({ body: { kind: 'form', fields: [kv('client_secret', 'FAKEs')] } });
    expect(proposeSecretName(find(form), new Set())).toBe('client_secret');
  });

  it('falls back to the rule for a finding in a text', () => {
    expect(
      proposeSecretName(
        find(restProject({ body: { kind: 'raw', language: 'json', text: `{"a":"${AWS}"}` } })),
        new Set(),
      ),
    ).toBe('aws_access_key');
  });

  it('reads a form field name from a long label in linear time', () => {
    const form = restProject({ body: { kind: 'form', fields: [kv('client_secret', 'FAKEs')] } });
    const f = find(form);
    const label = `body field ${'body field a'.repeat(50_000)}`;
    const started = performance.now();
    expect(proposeSecretName({ ...f, label }, new Set())).toMatch(/^body_field_a/);
    expect(performance.now() - started).toBeLessThan(200);
  });

  it('de-duplicates against taken names ignoring case', () => {
    const f = find(project({ properties: { password: 'changeme' } }));
    expect(proposeSecretName(f, new Set(['PASSWORD', 'password_2']))).toBe('password_3');
  });
});
