import { describe, expect, it } from 'vitest';
import { exportCollection } from '../../../src/export/index.js';
import { ocAssertion } from '../../../src/export/opencollection.js';
import { mapOpenCollection } from '../../../src/import/opencollection/map.js';
import { parseOpenCollection } from '../../../src/import/opencollection/parse.js';
import type { RestFolder, RestRequestDef } from '../../../src/rest/model.js';
import { joinBase } from '../../../src/rest/url.js';
import { newId, sampleProject } from './fixture.js';
import { restApisOf } from '../../../src/rest/model.js';

const project = sampleProject();

function names(node: { folders: readonly RestFolder[]; requests: readonly RestRequestDef[] }): unknown[] {
  return [
    ...node.folders.map((f) => ({ [f.name]: names(f), auth: f.auth?.type ?? 'inherit' })),
    ...node.requests.map((r) => `${r.method} ${r.name}`),
  ];
}

describe('OpenCollection export: round trip through the OpenCollection importer', () => {
  const result = exportCollection('opencollection', { project, target: { kind: 'project' } });
  const mapped = mapOpenCollection(parseOpenCollection(result.files[0]!.text), { newId });

  it('writes one document named after the project', () => {
    expect(result.files.map((f) => f.name)).toEqual(['pet-store.opencollection.yml']);
    expect(result.counts).toEqual({ requests: 6, folders: 6, environments: 1 });
  });

  it('gives back the folders and requests, SOAP as an XML POST', () => {
    expect(names(mapped.rest!)).toEqual([
      { Orders: [{ Submit: ['POST Request 1'], auth: 'inherit' }], auth: 'inherit' },
      { Pets: [{ Users: ['GET Get User', 'POST Create User'], auth: 'basic' }, 'POST Upload'], auth: 'bearer' },
    ]);
    const soap = mapped.rest!.folders[0]!.folders[0]!.requests[0]!;
    expect(soap.url).toBe('https://orders.example.com/soap');
    expect(soap.body).toEqual({
      kind: 'raw',
      language: 'xml',
      text: '<soap:Envelope><soap:Body><id>${orderId}</id></soap:Body></soap:Envelope>',
    });
    expect(soap.headers.map((h) => h.name)).toEqual(['Content-Type', 'SOAPAction']);
  });

  it('keeps a REST request whole: URL, rows, body, assertions, scripts and examples', () => {
    const [getUser, createUser] = mapped.rest!.folders[1]!.folders[0]!.requests;
    const original = restApisOf(project)[0]!.folders[0]!.requests[0]!;
    expect(joinBase(mapped.rest!.baseUrl, getUser!.url)).toBe('https://pets.example.com/users/{id}');
    expect(getUser!.pathParams).toEqual(original.pathParams);
    expect(getUser!.query).toEqual(original.query);
    expect(getUser!.headers).toEqual(original.headers);
    expect(getUser!.assertions).toEqual(original.assertions.slice(0, 2));
    expect(mapped.scripts.map((s) => s.source)).toEqual(["pm.environment.set('a', '1');"]);
    expect(createUser!.body).toEqual({ kind: 'raw', language: 'json', text: '{"name":"${name}"}' });
    expect(createUser!.examples?.map((e) => [e.name, e.status, e.body])).toEqual([['created', 201, '{"id":1}']]);
  });

  it('gives back the gRPC and WebSocket APIs', () => {
    expect(mapped.grpc?.target).toBe('localhost:50051');
    const pet = mapped.grpc!.folders[0]!.requests[0]!;
    expect([pet.service, pet.method, pet.methodKind, pet.message]).toEqual([
      'pets.v1.Pets',
      'Get',
      'unary',
      '{"id":1}',
    ]);
    const chat = mapped.websocket!.folders[0]!.requests[0]!;
    expect(chat.url).toBe('wss://pets.example.com/ws');
    expect(chat.messages.map((m) => m.content)).toEqual(['{"hi":"${name}"}']);
  });

  it('gives back the properties and the environment, secrets with no value', () => {
    expect(mapped.variables.projectProperties?.variables.map((v) => [v.name, v.value, v.enabled, v.secret])).toEqual([
      ['host', 'pets.example.com', true, false],
      ['apiToken', '', true, true],
      ['off', 'x', false, false],
    ]);
    expect(
      mapped.variables.environments.map((e) => [e.name, e.variables.map((v) => [v.name, v.value, v.secret])]),
    ).toEqual([
      [
        'Staging',
        [
          ['host', 'staging.example.com', false],
          ['token', '', true],
        ],
      ],
    ]);
  });

  it('reports the assertion it could not write and never writes a credential reference', () => {
    expect(result.report.warnings).toContain('Pets / Users / Get User: 1 assertion(s) are not represented.');
    expect(result.files[0]!.text).not.toMatch(/keychain-ref|\$\{secret:/);
  });

  it('puts a single API at the root with its auth on the collection', () => {
    const one = exportCollection('opencollection', {
      project,
      target: { kind: 'container', id: restApisOf(project)[0]!.id },
    });
    const back = mapOpenCollection(parseOpenCollection(one.files[0]!.text), { newId });
    expect(back.rest?.name).toBe('Pets');
    expect(back.rest?.auth?.type).toBe('bearer');
    expect(names(back.rest!)).toEqual([{ Users: ['GET Get User', 'POST Create User'], auth: 'basic' }, 'POST Upload']);
  });
});

describe('ocAssertion', () => {
  it('writes the assertions the importer reads back', () => {
    expect(ocAssertion({ type: 'status', equals: 201 })).toEqual({
      expression: 'res.status',
      operator: 'eq',
      value: '201',
    });
    expect(ocAssertion({ type: 'sla', maxMs: 500 })).toEqual({
      expression: 'res.responseTime',
      operator: 'lt',
      value: '500',
    });
    expect(ocAssertion({ type: 'match', language: 'jsonpath', expression: '$.a[0].b', equals: 3 })).toEqual({
      expression: 'res.body.a[0].b',
      operator: 'eq',
      value: '3',
    });
    expect(ocAssertion({ type: 'match', language: 'jsonpath', expression: '$.a', exists: false })?.['operator']).toBe(
      'isNull',
    );
    expect(ocAssertion({ type: 'match', language: 'jsonpath', expression: '$.a', matches: 'a\\.b' })).toEqual({
      expression: 'res.body.a',
      operator: 'contains',
      value: 'a.b',
    });
  });

  it('has nothing for what OpenCollection cannot express', () => {
    expect(ocAssertion({ type: 'status', equals: [200, 201] })).toBeUndefined();
    expect(ocAssertion({ type: 'match', language: 'jsonpath', expression: '$.a', matches: 'a.*' })).toBeUndefined();
    expect(ocAssertion({ type: 'match', language: 'xpath', expression: '//a', exists: true })).toBeUndefined();
    expect(ocAssertion({ type: 'schema' })).toBeUndefined();
    // Text that would be read back as a number or a boolean, and a match checking two things.
    expect(ocAssertion({ type: 'match', language: 'jsonpath', expression: '$.a', equals: '123' })).toBeUndefined();
    expect(
      ocAssertion({ type: 'match', language: 'jsonpath', expression: '$.a', equals: 1, exists: true }),
    ).toBeUndefined();
  });
});
