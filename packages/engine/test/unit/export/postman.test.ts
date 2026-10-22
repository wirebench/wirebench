import { describe, expect, it } from 'vitest';
import { ExportError } from '#core/errors';
import { exportCollection } from '../../../src/export/index.js';
import type { RestFolder, RestRequestDef } from '#protocol-rest/rest/model';
import { createRestRequest } from '#protocol-rest/rest/model';
import { apiFromPostmanCollection } from '#protocol-rest/rest/postman/map';
import { parsePostmanCollectionText } from '#protocol-rest/rest/postman/parse';
import { parsePostmanVariablesText } from '#protocol-rest/rest/postman/variables';
import { joinBase } from '#protocol-rest/rest/url';
import { newId, sampleProject } from './fixture.js';
import { restApisOf, withRestApis } from '#protocol-rest/rest/model';

const project = sampleProject();
const restId = restApisOf(project)[0]!.id;

function exportApi() {
  return exportCollection('postman', { project, target: { kind: 'container', id: restId }, newId });
}

/** The request's name, method, effective URL, rows, body and auth kind: what a round trip must keep. */
function shape(baseUrl: string, r: RestRequestDef) {
  return {
    name: r.name,
    method: r.method,
    url: joinBase(baseUrl, r.url).replace(/\?.*$/, ''),
    pathParams: r.pathParams.map((p) => [p.name, p.value]),
    query: r.query.map((q) => [q.name, q.value, q.enabled]),
    headers: r.headers.map((h) => [h.name, h.value]),
    body: r.body,
    auth: r.auth.type,
  };
}

function flatten(
  baseUrl: string,
  node: { folders: readonly RestFolder[]; requests: readonly RestRequestDef[] },
  trail = '',
): unknown[] {
  return [
    ...node.folders.flatMap((f) => [
      `folder ${trail}${f.name} ${f.auth?.type ?? 'inherit'}`,
      ...flatten(baseUrl, f, `${trail}${f.name}/`),
    ]),
    ...node.requests.map((r) => shape(baseUrl, r)),
  ];
}

describe('Postman export: round trip through the Postman importer', () => {
  it('gives back the same API', () => {
    const result = exportApi();
    expect(result.files.map((f) => f.name)).toEqual([
      'pets.postman_collection.json',
      'staging.postman_environment.json',
    ]);
    const imported = apiFromPostmanCollection(parsePostmanCollectionText(result.files[0]!.text), { newId });
    const original = restApisOf(project)[0]!;
    expect(imported.api.name).toBe('Pets');
    expect(imported.api.auth?.type).toBe('bearer');
    expect(flatten(imported.api.baseUrl, imported.api)).toEqual(flatten(original.baseUrl, original));
    // Scripts come back on the request they were on, switched off.
    const getUser = imported.api.folders[0]!.requests[0]!;
    expect(getUser.scripts?.pre?.text).toContain("pm.environment.set('a', '1');");
    expect(getUser.scripts?.api).toBe('postman');
  });

  it('writes project properties as collection variables, a secret with no value', () => {
    const imported = apiFromPostmanCollection(parsePostmanCollectionText(exportApi().files[0]!.text), { newId });
    const vars = imported.projectProperties.variables.map((v) => [v.name, v.value, v.enabled, v.secret]);
    expect(vars).toEqual([
      ['host', 'pets.example.com', true, false],
      ['apiToken', '', true, true],
      ['off', 'x', false, false],
    ]);
  });

  it('writes each environment as a file the environment importer reads', () => {
    const env = parsePostmanVariablesText(exportApi().files[1]!.text);
    expect(env.environments).toHaveLength(1);
    expect(env.environments[0]!.name).toBe('Staging');
    expect(env.environments[0]!.variables.map((v) => [v.name, v.value, v.secret])).toEqual([
      ['host', 'staging.example.com', false],
      ['token', '', true],
    ]);
  });
});

describe('Postman export: what does not fit', () => {
  const whole = exportCollection('postman', { project, target: { kind: 'project' }, newId });
  const collection = JSON.parse(whole.files[0]!.text) as { item: { name: string; item: unknown[] }[] };

  it('writes SOAP and REST containers as folders and leaves gRPC and WebSocket out', () => {
    expect(collection.item.map((i) => i.name)).toEqual(['Orders', 'Pets']);
    expect(whole.report.warnings).toContain(
      'Pets gRPC: gRPC requests are not represented by Postman Collection v2.1 and were left out.',
    );
    expect(whole.report.warnings).toContain(
      'Socket: WebSocket requests are not represented by Postman Collection v2.1 and were left out.',
    );
    expect(whole.counts).toEqual({ requests: 4, folders: 4, environments: 1 });
  });

  it('writes a SOAP request as an XML POST with its action', () => {
    const text = whole.files[0]!.text;
    const parsed = parsePostmanCollectionText(text);
    const soap = parsed.item[0]!.item![0]!.item![0]!;
    expect(soap.name).toBe('Request 1');
    const request = soap.request as { method: string; header: { key: string; value: string }[]; body: { raw: string } };
    expect(request.method).toBe('POST');
    expect(request.header).toEqual([
      { key: 'Content-Type', value: 'text/xml; charset=utf-8' },
      { key: 'SOAPAction', value: '"urn:submit"' },
    ]);
    expect(request.body.raw).toContain('<id>${orderId}</id>');
    expect(whole.report.warnings).toContain('Orders / Submit / Request 1: WS-Security is not represented.');
  });

  it('reports assertions, dropped credentials and the variables it declared', () => {
    expect(whole.report.warnings).toContain('Pets / Users / Get User: 3 assertion(s) are not represented.');
    expect(whole.report.warnings).toContain(
      'Pets: the bearer credential was not exported; re-enter it in the target tool.',
    );
    expect(whole.report.warnings).toContain(
      'Pets / Users: the basic credential was not exported; re-enter it in the target tool.',
    );
    expect(whole.report.notes).toContain(
      'Pets / Users / Get User: its scripts were switched off in Wirebench; the target tool runs them.',
    );
  });

  it('never writes a credential reference', () => {
    for (const file of whole.files) {
      expect(file.text).not.toContain('keychain-ref');
      expect(file.text).not.toMatch(/passwordRef|tokenRef|\$\{secret:/);
    }
  });
});

describe('Postman export: errors', () => {
  it('refuses an unknown container', () => {
    expect(() => exportCollection('postman', { project, target: { kind: 'container', id: 'nope' } })).toThrow(
      ExportError,
    );
  });

  it('refuses a target with nothing it can write', () => {
    const grpcOnly = { ...project, containers: { ...project.containers, soap: [], rest: [], websocket: [] } };
    expect(() => exportCollection('postman', { project: grpcOnly, target: { kind: 'project' } })).toThrow(
      /Nothing in it can be written/,
    );
  });
});

describe('Postman export: API and folder scripts (#334)', () => {
  it('writes them as collection and folder events, which the importer puts back on their level', () => {
    const api = restApisOf(project)[0]!;
    const off = { api: 'postman', enabled: true, secrets: [] } as const;
    const levelled = withRestApis(project, [
      {
        ...api,
        scripts: { pre: { text: 'pm.variables.set("api", "1");' }, ...off },
        folders: [{ ...api.folders[0]!, scripts: { post: { text: 'pm.test("folder", () => {});' }, ...off } }],
      },
    ]);
    const result = exportCollection('postman', { project: levelled, target: { kind: 'container', id: restId }, newId });
    const imported = apiFromPostmanCollection(parsePostmanCollectionText(result.files[0]!.text), { newId });
    expect(imported.api.scripts?.pre?.text).toBe('pm.variables.set("api", "1");\n');
    expect(imported.api.folders[0]?.scripts?.post?.text).toBe('pm.test("folder", () => {});\n');
  });
});

describe('Postman export: scripts written for another API', () => {
  const withApi = (api: 'postman' | 'insomnia' | 'bruno') => {
    const rest = restApisOf(project)[0]!;
    const scripts = { pre: { text: 'run();' }, api, enabled: true, secrets: [] } as const;
    return withRestApis(project, [{ ...rest, folders: [{ ...rest.folders[0]!, scripts }] }]);
  };
  const warnings = (api: 'postman' | 'insomnia' | 'bruno') =>
    exportCollection('postman', { project: withApi(api), target: { kind: 'container', id: restId }, newId }).report
      .warnings;

  it('warns, naming the API and the folder, for Bruno and Insomnia scripts', () => {
    expect(warnings('bruno')).toContain(
      "Pets / Users: its scripts use Bruno's script API; the target tool will not run them.",
    );
    expect(warnings('insomnia')).toContain(
      "Pets / Users: its scripts use Insomnia's script API; the target tool will not run them.",
    );
  });

  it('does not warn for Postman scripts', () => {
    expect(warnings('postman').some((w) => w.includes('script API'))).toBe(false);
  });
});

describe('Postman export: a GraphQL body (#77)', () => {
  const graphql: RestRequestDef = {
    ...createRestRequest('Product', { id: 'req-gql', slug: 'product', method: 'POST', url: '/graphql' }),
    body: { kind: 'graphql', query: 'query P($id: ID!) { product(id: $id) { name } }', variables: '{"id": "${id}"}' },
  };
  const withGraphql = withRestApis(project, [
    { ...restApisOf(project)[0]!, requests: [...restApisOf(project)[0]!.requests, graphql] },
  ]);

  it('writes mode graphql, and comes back as the same body', () => {
    const result = exportCollection('postman', {
      project: withGraphql,
      target: { kind: 'container', id: restId },
      newId,
    });
    const text = result.files[0]!.text;
    expect(text).toContain('"mode": "graphql"');
    const imported = apiFromPostmanCollection(parsePostmanCollectionText(text), { newId });
    expect(imported.api.requests.find((r) => r.name === 'Product')?.body).toEqual(graphql.body);
  });

  it('writes the JSON it is sent as to an OpenCollection', () => {
    const result = exportCollection('opencollection', {
      project: withGraphql,
      target: { kind: 'container', id: restId },
      newId,
    });
    const all = result.files.map((f) => f.text).join('\n');
    expect(all).toContain('"query":"query P($id: ID!) { product(id: $id) { name } }","variables":{"id": "{{id}}"}');
  });
});
