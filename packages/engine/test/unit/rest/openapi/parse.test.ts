/**
 * Reading an OpenAPI document.
 *
 * The parser's contract is tolerance with an account: anything it cannot use is skipped *and
 * counted*, so the import summary can name it, and only three things are fatal — text that parses as
 * neither JSON nor YAML, a document that is not OpenAPI, and Swagger 2.0. Each case below is one of
 * those two halves.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { parseDocumentText, parseOpenApiDocument, versionOf } from '../../../../src/rest/openapi/parse.js';
import { serverUrl } from '../../../../src/rest/openapi/model.js';
import type { OpenApiDocument } from '../../../../src/rest/openapi/model.js';

const craftedDir = fileURLToPath(new URL('../../../../../../fixtures/openapi/crafted/', import.meta.url));

/** Parses one crafted fixture straight from disk — no `$ref` resolution, which has its own test. */
function crafted(name: string): OpenApiDocument {
  return parseOpenApiDocument(parseDocumentText(readFileSync(`${craftedDir}${name}/openapi.yaml`, 'utf-8')));
}

describe('parseDocumentText', () => {
  it('reads JSON and YAML alike', () => {
    expect(parseDocumentText('{"a":1}')).toEqual({ a: 1 });
    expect(parseDocumentText('a: 1\n')).toEqual({ a: 1 });
  });

  it('reads JSON through a byte-order mark, which a generated file often carries', () => {
    expect(parseDocumentText('﻿{"a":1}')).toEqual({ a: 1 });
  });

  it('names the format in the error, because that is what the user has to fix', () => {
    expect(() => parseDocumentText('{"a":')).toThrowError(/not valid JSON/);
    expect(() => parseDocumentText('a: [1,\n b: 2')).toThrowError(/not valid YAML/);
  });
});

describe('versionOf', () => {
  it('accepts 3.0.x, 3.1.x and 3.2.x, keeping what the document actually said', () => {
    expect(versionOf({ openapi: '3.0.3' })).toEqual({ version: '3.0', declared: '3.0.3' });
    expect(versionOf({ openapi: '3.1.0' })).toEqual({ version: '3.1', declared: '3.1.0' });
    expect(versionOf({ openapi: '3.2.0' })).toEqual({ version: '3.2', declared: '3.2.0' });
    expect(versionOf({ openapi: '3.2.1' })).toEqual({ version: '3.2', declared: '3.2.1' });
  });

  it('accepts documents declaring Swagger 3.0.x, 3.1.x and 3.2.0', () => {
    expect(versionOf({ swagger: '3.0.0' })).toEqual({ version: '3.0', declared: 'Swagger 3.0.0' });
    expect(versionOf({ swagger: '3.0.3' })).toEqual({ version: '3.0', declared: 'Swagger 3.0.3' });
    expect(versionOf({ swagger: '3.1.0' })).toEqual({ version: '3.1', declared: 'Swagger 3.1.0' });
    expect(versionOf({ swagger: '3.2.0' })).toEqual({ version: '3.2', declared: 'Swagger 3.2.0' });
  });

  it('accepts documents declaring Swagger 2.0 and 2.x', () => {
    expect(versionOf({ swagger: '2.0' })).toEqual({ version: '2.0', declared: 'Swagger 2.0' });
    expect(versionOf({ swagger: '2.0.1' })).toEqual({ version: '2.0', declared: 'Swagger 2.0.1' });
  });

  it('accepts documents declaring Swagger 1.0, 1.1, and 1.2', () => {
    expect(versionOf({ swaggerVersion: '1.2' })).toEqual({ version: '1.2', declared: 'Swagger 1.2' });
    expect(versionOf({ swaggerVersion: '1.1' })).toEqual({ version: '1.2', declared: 'Swagger 1.1' });
    expect(versionOf({ swaggerVersion: '1.0' })).toEqual({ version: '1.2', declared: 'Swagger 1.0' });
    expect(versionOf({ swagger: '1.2' })).toEqual({ version: '1.2', declared: 'Swagger 1.2' });
  });

  it('refuses unsupported Swagger versions (e.g. 9.0)', () => {
    expect(() => versionOf({ swagger: '9.0' })).toThrowError(/Swagger 9\.0/);
    try {
      versionOf({ swagger: '9.0' });
    } catch (error) {
      expect(error).toMatchObject({ code: 'openapi-unsupported-version' });
      expect((error as Error).message).toContain('Swagger 1.x, 2.0, 3.x and OpenAPI 3.0, 3.1, 3.2');
    }
  });

  it('refuses an OpenAPI major it does not read', () => {
    try {
      versionOf({ openapi: '4.0.0' });
    } catch (error) {
      expect(error).toMatchObject({ code: 'openapi-unsupported-version' });
    }
  });

  it('refuses something that is not a document at all', () => {
    for (const value of [{ paths: {} }, [], 'text', null]) {
      try {
        versionOf(value);
        expect.unreachable();
      } catch (error) {
        expect(error).toMatchObject({ code: 'openapi-not-a-document' });
      }
    }
  });
});

describe('parsing the parameters fixture', () => {
  const document = crafted('parameters');

  it('merges path-level and operation-level parameters, the operation winning', () => {
    const operation = document.operations[0]!;
    const petId = operation.parameters.filter((parameter) => parameter.name === 'petId');
    expect(petId).toHaveLength(1);
    expect(petId[0]?.example).toBe('p-override');
  });

  it('keeps every location, cookie included, so the import can say it skipped one', () => {
    const locations = crafted('parameters').operations[0]!.parameters.map((parameter) => parameter.in);
    expect(new Set(locations)).toEqual(new Set(['path', 'query', 'header', 'cookie']));
  });

  it('keeps required, the schema, its enum and the example', () => {
    const size = document.operations[0]!.parameters.find((parameter) => parameter.name === 'size');
    expect(size).toMatchObject({ required: true, in: 'query', schema: { type: 'string', enum: ['small', 'large'] } });
    const tag = document.operations[0]!.parameters.find((parameter) => parameter.name === 'tag');
    expect(tag?.required).toBeUndefined();
  });

  it('reads the operation in document order, with its method, path and tags', () => {
    expect(document.operations).toHaveLength(1);
    expect(document.operations[0]).toMatchObject({
      method: 'get',
      path: '/pets/{petId}/photos/{photoId}',
      operationId: 'getPhoto',
      summary: 'Read one photo',
      tags: ['Pets'],
    });
  });
});

describe('parsing the bodies fixture', () => {
  const document = crafted('bodies');

  it("reads every media type an operation offers, in the document's order", () => {
    const prefers = document.operations.find((operation) => operation.operationId === 'postPrefersJson');
    expect(Object.keys(prefers?.requestBody?.content ?? {})).toEqual(['text/plain', 'application/json']);
  });

  it('keeps an example, the named examples, and a schema with neither', () => {
    const withExample = document.operations.find((operation) => operation.operationId === 'postJson');
    expect(withExample?.requestBody?.content['application/json']?.example).toEqual({ name: 'Fido' });

    const withExamples = document.operations.find((operation) => operation.operationId === 'postJsonExamples');
    expect(Object.keys(withExamples?.requestBody?.content['application/json']?.examples ?? {})).toEqual([
      'first',
      'second',
    ]);

    const withSchema = document.operations.find((operation) => operation.operationId === 'postJsonSample');
    expect(withSchema?.requestBody?.content['application/json']?.schema).toMatchObject({
      type: 'object',
      required: ['id'],
    });
  });

  it('keeps the xml object a schema carries', () => {
    const xml = document.operations.find((operation) => operation.operationId === 'postXml');
    expect(xml?.requestBody?.content['application/xml']?.schema?.xml).toEqual({ name: 'pet' });
  });

  it('keeps a binary format, which decides a Binary body', () => {
    const binary = document.operations.find((operation) => operation.operationId === 'putBinary');
    expect(binary?.requestBody?.content['application/octet-stream']?.schema).toMatchObject({ format: 'binary' });
  });

  it('keeps whether the body is required', () => {
    expect(document.operations.find((operation) => operation.operationId === 'postJson')?.requestBody?.required).toBe(
      true,
    );
  });
});

describe('parsing the schemas fixture', () => {
  const document = crafted('schemas');

  it('keeps allOf, oneOf and the formats for the sample generator', () => {
    const allOf = document.operations.find((operation) => operation.operationId === 'postAllOf');
    expect(allOf?.requestBody?.content['application/json']?.schema?.allOf).toHaveLength(2);

    const oneOf = document.operations.find((operation) => operation.operationId === 'postOneOf');
    expect(oneOf?.requestBody?.content['application/json']?.schema?.oneOf).toHaveLength(2);

    const formats = document.operations.find((operation) => operation.operationId === 'postFormats');
    const properties = formats?.requestBody?.content['application/json']?.schema?.properties ?? {};
    expect(Object.values(properties).map((schema) => schema.format)).toEqual(['date-time', 'uuid', 'email', 'uri']);
  });

  it('keeps a nested object and an array of enums', () => {
    const nested = document.operations.find((operation) => operation.operationId === 'postNested');
    const schema = nested?.requestBody?.content['application/json']?.schema;
    expect(schema?.properties?.['tags']?.items?.enum).toEqual(['red', 'green']);
    expect(schema?.properties?.['pet']?.required).toEqual(['name']);
  });
});

describe('parsing the security fixture', () => {
  const document = crafted('security');

  it('reads every scheme type, keeping the apiKey parameter name apart from the scheme name', () => {
    const byName = new Map(document.securitySchemes.map((scheme) => [scheme.name, scheme]));
    expect(byName.get('bearerAuth')).toMatchObject({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' });
    expect(byName.get('basicAuth')).toMatchObject({ type: 'http', scheme: 'basic' });
    expect(byName.get('apiKeyHeader')).toMatchObject({ type: 'apiKey', in: 'header', keyName: 'X-Api-Key' });
    expect(byName.get('apiKeyCookie')).toMatchObject({ type: 'apiKey', in: 'cookie' });
    expect(byName.get('oauthClient')?.flows?.['clientCredentials']).toMatchObject({
      tokenUrl: 'https://secure.test/oauth/token',
      scopes: { read: 'Read everything' },
    });
    expect(byName.get('oauthCode')?.flows?.['authorizationCode']).toMatchObject({
      authorizationUrl: 'https://secure.test/oauth/authorize',
    });
    expect(byName.get('openId')).toMatchObject({ type: 'openIdConnect' });
  });

  it('reads the document requirement and each operation that overrides it', () => {
    expect(document.security).toEqual([{ bearerAuth: [] }]);
    const byId = new Map(document.operations.map((operation) => [operation.operationId, operation]));
    expect(byId.get('getInherits')?.security).toBeUndefined();
    expect(byId.get('getBasic')?.security).toEqual([{ basicAuth: [] }]);
    // `security: []` is "explicitly unauthenticated", which is not the same as saying nothing.
    expect(byId.get('getOpen')?.security).toEqual([]);
  });
});

describe('parsing the servers fixture', () => {
  const document = crafted('servers');

  it('keeps every server, its description and its variables', () => {
    expect(document.servers).toHaveLength(3);
    expect(document.servers[0]).toMatchObject({
      url: 'https://{tenant}.api.test/{version}',
      description: 'Tenanted',
    });
    expect(document.servers[0]?.variables?.['tenant']).toMatchObject({ default: 'acme', enum: ['acme', 'globex'] });
  });

  it('substitutes each variable default into the URL', () => {
    expect(serverUrl(document.servers[0]!)).toBe('https://acme.api.test/v2');
    expect(serverUrl(document.servers[1]!)).toBe('https://sandbox.api.test/v2');
  });

  it('leaves a variable with no default as the template, so the user decides', () => {
    expect(serverUrl(document.servers[2]!)).toBe('https://{region}.api.test');
  });
});

describe('parsing the deprecated fixture', () => {
  it('marks a deprecated operation and keeps the tag descriptions', () => {
    const document = crafted('deprecated');
    const byId = new Map(document.operations.map((operation) => [operation.operationId, operation]));
    expect(byId.get('listPets')?.deprecated).toBeUndefined();
    expect(byId.get('listPetsOld')?.deprecated).toBe(true);
    expect(document.tags).toEqual([{ name: 'Pets', description: 'Everything about pets' }]);
  });
});

describe('parsing the 3.1 fixture', () => {
  const document = crafted('v31');

  it('reads 3.1 spellings: a nullable type list, a const and schema examples', () => {
    const schema = document.operations[0]?.requestBody?.content['application/json']?.schema;
    expect(schema?.properties?.['nickname']?.type).toEqual(['string', 'null']);
    expect(schema?.properties?.['kind']?.const).toBe('dog');
    expect(schema?.properties?.['name']?.examples).toEqual(['Fido']);
  });

  it('counts what it does not import, and says where each was', () => {
    const kinds = document.skipped.map((entry) => entry.kind);
    expect(kinds).toContain('webhook');
    expect(kinds).toContain('callback');
    expect(kinds).toContain('extension');
    const webhook = document.skipped.find((entry) => entry.kind === 'webhook');
    expect(webhook?.where).toBe('/webhooks/petCreated');
    // The two extensions: one at the root, one on the operation.
    expect(document.skipped.filter((entry) => entry.kind === 'extension')).toHaveLength(2);
  });
});

describe('parsing the 3.2 fixture', () => {
  const document = crafted('v32');

  it('reads 3.2 document version', () => {
    expect(document.version).toBe('3.2');
    expect(document.declaredVersion).toBe('3.2.0');
  });

  it('reads additionalOperations, importing non-standard methods like QUERY', () => {
    const queryOp = document.operations.find((op) => op.operationId === 'searchPets');
    expect(queryOp).toBeDefined();
    expect(queryOp).toMatchObject({
      method: 'query',
      path: '/search',
      summary: 'Search pets via QUERY',
      tags: ['Search'],
    });
  });

  it('reads dataValue from 3.2 Example Object', () => {
    const queryOp = document.operations.find((op) => op.operationId === 'searchPets');
    const examples = queryOp?.requestBody?.content['application/json']?.examples;
    expect(examples?.['sampleQuery']).toBeDefined();
    expect(examples?.['sampleQuery']?.dataValue).toEqual({ term: 'beagle' });
    expect(examples?.['sampleQuery']?.value).toEqual({ term: 'beagle' });
  });

  it('reads itemSchema on sequential/streaming media types when schema is absent', () => {
    const streamOp = document.operations.find((op) => op.operationId === 'postStream');
    const media = streamOp?.requestBody?.content['text/event-stream'];
    expect(media?.itemSchema).toMatchObject({
      type: 'object',
      required: ['message'],
    });
    expect(media?.schema).toMatchObject({
      type: 'object',
      required: ['message'],
    });
  });
});

describe('tolerance', () => {
  it('skips a malformed operation rather than failing the document', () => {
    const document = parseOpenApiDocument({
      openapi: '3.0.3',
      info: { title: 'Rough' },
      paths: { '/a': { get: 'not an object' }, '/b': 'not a path item', '/c': { post: { operationId: 'ok' } } },
    });

    expect(document.operations.map((operation) => operation.operationId)).toEqual(['ok']);
    expect(document.skipped).toEqual([
      { kind: 'operation', where: 'GET /a', reason: 'not an object' },
      { kind: 'path', where: '/paths//b', reason: 'not a path item' },
    ]);
  });

  it('skips a parameter with no name, naming the operation it was on', () => {
    const document = parseOpenApiDocument({
      openapi: '3.0.3',
      info: { title: 'Rough' },
      paths: { '/a': { get: { parameters: [{ in: 'query' }, { name: 'ok', in: 'query' }] } } },
    });

    expect(document.operations[0]?.parameters.map((parameter) => parameter.name)).toEqual(['ok']);
    expect(document.skipped[0]).toMatchObject({ kind: 'parameter', where: 'GET /a #0' });
  });

  it('reports a body whose $ref never resolved, rather than pretending there is none', () => {
    const document = parseOpenApiDocument({
      openapi: '3.0.3',
      info: { title: 'Rough' },
      paths: { '/a': { post: { requestBody: { $ref: '#/components/requestBodies/Missing' } } } },
    });

    expect(document.operations[0]?.requestBody).toBeUndefined();
    expect(document.skipped[0]).toMatchObject({ kind: 'requestBody', reason: 'its $ref could not be resolved' });
  });

  it('takes a document with no title, no servers and no paths', () => {
    const document = parseOpenApiDocument({ openapi: '3.0.3' });
    expect(document).toMatchObject({ info: { title: 'Imported API' }, servers: [], operations: [] });
  });

  describe('Swagger 2.0 documents', () => {
    it('derives server URLs from schemes, host, and basePath', () => {
      const doc = parseOpenApiDocument({
        swagger: '2.0',
        info: { title: 'Test' },
        host: 'api.example.com',
        basePath: '/v1',
        schemes: ['https', 'http'],
      });
      expect(doc.servers).toEqual([{ url: 'https://api.example.com/v1' }, { url: 'http://api.example.com/v1' }]);
    });

    it('defaults to https when host is given without schemes', () => {
      const doc = parseOpenApiDocument({
        swagger: '2.0',
        info: { title: 'Test' },
        host: 'api.example.com',
      });
      expect(doc.servers).toEqual([{ url: 'https://api.example.com' }]);
    });

    it('uses basePath when host is absent, or falls back to /', () => {
      const withBase = parseOpenApiDocument({
        swagger: '2.0',
        info: { title: 'Test' },
        basePath: '/api',
      });
      expect(withBase.servers).toEqual([{ url: '/api' }]);

      const bare = parseOpenApiDocument({
        swagger: '2.0',
        info: { title: 'Test' },
      });
      expect(bare.servers).toEqual([{ url: '/' }]);
    });

    it('converts primitive path, query, and header parameters to schemas', () => {
      const doc = parseOpenApiDocument({
        swagger: '2.0',
        info: { title: 'Params' },
        paths: {
          '/users/{id}': {
            get: {
              parameters: [
                { name: 'id', in: 'path', required: true, type: 'integer', format: 'int64' },
                { name: 'filter', in: 'query', type: 'string', default: 'active' },
                {
                  name: 'roles',
                  in: 'query',
                  type: 'array',
                  items: { type: 'string' },
                  collectionFormat: 'multi',
                },
                { name: 'X-Tenant', in: 'header', type: 'string', required: true },
              ],
            },
          },
        },
      });

      const op = doc.operations[0];
      expect(op?.parameters).toHaveLength(4);

      const [id, filter, roles, tenant] = op!.parameters;
      expect(id).toMatchObject({
        name: 'id',
        in: 'path',
        required: true,
        schema: { type: 'integer', format: 'int64' },
      });
      expect(filter).toMatchObject({
        name: 'filter',
        in: 'query',
        schema: { type: 'string', default: 'active' },
        example: 'active',
      });
      expect(roles).toMatchObject({
        name: 'roles',
        in: 'query',
        schema: { type: 'array', items: { type: 'string' } },
        style: 'form',
        explode: true,
      });
      expect(tenant).toMatchObject({
        name: 'X-Tenant',
        in: 'header',
        required: true,
        schema: { type: 'string' },
      });
    });

    it('converts in: "body" parameter into requestBody', () => {
      const doc = parseOpenApiDocument({
        swagger: '2.0',
        info: { title: 'Body' },
        consumes: ['application/json', 'application/xml'],
        paths: {
          '/items': {
            post: {
              parameters: [
                {
                  name: 'item',
                  in: 'body',
                  required: true,
                  description: 'New item',
                  schema: {
                    type: 'object',
                    properties: { name: { type: 'string' } },
                  },
                },
              ],
            },
          },
        },
      });

      const op = doc.operations[0];
      expect(op?.requestBody).toBeDefined();
      expect(op?.requestBody?.required).toBe(true);
      expect(op?.requestBody?.description).toBe('New item');
      expect(Object.keys(op?.requestBody?.content ?? {})).toEqual(['application/json', 'application/xml']);
      expect(op?.requestBody?.content['application/json']?.schema).toMatchObject({
        type: 'object',
        properties: { name: { type: 'string' } },
      });
    });

    it('converts in: "formData" parameters to urlencoded and multipart requestBody', () => {
      const formDoc = parseOpenApiDocument({
        swagger: '2.0',
        info: { title: 'Form' },
        paths: {
          '/login': {
            post: {
              parameters: [
                { name: 'username', in: 'formData', type: 'string', required: true },
                { name: 'password', in: 'formData', type: 'string', required: true },
              ],
            },
          },
        },
      });

      const formOp = formDoc.operations[0];
      expect(formOp?.requestBody).toBeDefined();
      expect(Object.keys(formOp?.requestBody?.content ?? {})).toEqual(['application/x-www-form-urlencoded']);
      expect(formOp?.requestBody?.content['application/x-www-form-urlencoded']?.schema).toMatchObject({
        type: 'object',
        properties: {
          username: { type: 'string' },
          password: { type: 'string' },
        },
        required: ['username', 'password'],
      });

      const multiDoc = parseOpenApiDocument({
        swagger: '2.0',
        info: { title: 'Upload' },
        paths: {
          '/upload': {
            post: {
              parameters: [
                { name: 'file', in: 'formData', type: 'file', required: true, description: 'File to upload' },
                { name: 'description', in: 'formData', type: 'string' },
              ],
            },
          },
        },
      });

      const multiOp = multiDoc.operations[0];
      expect(multiOp?.requestBody).toBeDefined();
      expect(Object.keys(multiOp?.requestBody?.content ?? {})).toEqual(['multipart/form-data']);
      expect(multiOp?.requestBody?.content['multipart/form-data']?.schema).toMatchObject({
        type: 'object',
        properties: {
          file: { type: 'string', format: 'binary', description: 'File to upload' },
          description: { type: 'string' },
        },
      });
    });

    it('converts securityDefinitions to OpenApiSecurityScheme entries', () => {
      const doc = parseOpenApiDocument({
        swagger: '2.0',
        info: { title: 'Security' },
        securityDefinitions: {
          basicAuth: {
            type: 'basic',
            description: 'HTTP Basic',
          },
          apiKeyAuth: {
            type: 'apiKey',
            name: 'api_key',
            in: 'header',
          },
          oauthClient: {
            type: 'oauth2',
            flow: 'application',
            tokenUrl: 'https://auth.test/token',
            scopes: { 'read:all': 'Read everything' },
          },
          oauthCode: {
            type: 'oauth2',
            flow: 'accessCode',
            authorizationUrl: 'https://auth.test/auth',
            tokenUrl: 'https://auth.test/token',
            scopes: { 'write:all': 'Write everything' },
          },
        },
      });

      expect(doc.securitySchemes).toHaveLength(4);
      expect(doc.securitySchemes.find((s) => s.name === 'basicAuth')).toMatchObject({
        type: 'http',
        scheme: 'basic',
        description: 'HTTP Basic',
      });
      expect(doc.securitySchemes.find((s) => s.name === 'apiKeyAuth')).toMatchObject({
        type: 'apiKey',
        in: 'header',
        keyName: 'api_key',
      });
      expect(doc.securitySchemes.find((s) => s.name === 'oauthClient')).toMatchObject({
        type: 'oauth2',
        flows: {
          clientCredentials: {
            tokenUrl: 'https://auth.test/token',
            scopes: { 'read:all': 'Read everything' },
          },
        },
      });
      expect(doc.securitySchemes.find((s) => s.name === 'oauthCode')).toMatchObject({
        type: 'oauth2',
        flows: {
          authorizationCode: {
            authorizationUrl: 'https://auth.test/auth',
            tokenUrl: 'https://auth.test/token',
            scopes: { 'write:all': 'Write everything' },
          },
        },
      });
    });

    it('merges path and operation parameters with operation winning', () => {
      const doc = parseOpenApiDocument({
        swagger: '2.0',
        info: { title: 'Merge' },
        paths: {
          '/items/{id}': {
            parameters: [
              { name: 'id', in: 'path', required: true, type: 'integer' },
              { name: 'detail', in: 'query', type: 'boolean', default: false },
            ],
            get: {
              parameters: [
                { name: 'detail', in: 'query', type: 'boolean', default: true },
                { name: 'extra', in: 'query', type: 'string' },
              ],
            },
          },
        },
      });

      const params = doc.operations[0]?.parameters;
      expect(params).toHaveLength(3);
      const detail = params?.find((p) => p.name === 'detail');
      expect(detail?.schema?.default).toBe(true);
    });
  });

  describe('Swagger 1.x documents', () => {
    it('derives server URLs from basePath', () => {
      const doc = parseOpenApiDocument({
        swaggerVersion: '1.2',
        basePath: 'http://petstore.swagger.wordnik.com/api',
        apis: [],
      });
      expect(doc.servers).toEqual([{ url: 'http://petstore.swagger.wordnik.com/api' }]);
    });

    it('derives title and tags from resourcePath and info', () => {
      const doc = parseOpenApiDocument({
        swaggerVersion: '1.2',
        basePath: 'http://example.com/api',
        resourcePath: '/pets',
        info: { title: 'Pet API', description: 'Pet operations' },
        apis: [],
      });
      expect(doc.info.title).toBe('Pet API');
      expect(doc.tags).toEqual([{ name: 'pets', description: 'Pet operations' }]);
    });

    it('converts primitive path, query, and header parameters, including allowMultiple', () => {
      const doc = parseOpenApiDocument({
        swaggerVersion: '1.2',
        basePath: 'http://example.com/api',
        apis: [
          {
            path: '/pets/{id}',
            operations: [
              {
                method: 'GET',
                summary: 'Get pet',
                nickname: 'getPet',
                parameters: [
                  { name: 'id', paramType: 'path', required: true, type: 'integer', format: 'int64' },
                  { name: 'status', paramType: 'query', type: 'string', defaultValue: 'active', enum: ['active', 'sold'] },
                  { name: 'tags', paramType: 'query', type: 'string', allowMultiple: true },
                  { name: 'X-Key', paramType: 'header', type: 'string', required: true },
                ],
              },
            ],
          },
        ],
      });

      const op = doc.operations[0];
      expect(op?.parameters).toHaveLength(4);
      const [id, status, tags, key] = op!.parameters;

      expect(id).toMatchObject({
        name: 'id',
        in: 'path',
        required: true,
        schema: { type: 'integer', format: 'int64' },
      });
      expect(status).toMatchObject({
        name: 'status',
        in: 'query',
        schema: { type: 'string', enum: ['active', 'sold'], default: 'active' },
        example: 'active',
      });
      expect(tags).toMatchObject({
        name: 'tags',
        in: 'query',
        schema: { type: 'array', items: { type: 'string' } },
      });
      expect(key).toMatchObject({
        name: 'X-Key',
        in: 'header',
        required: true,
        schema: { type: 'string' },
      });
    });

    it('converts in: "body" parameter with model reference into requestBody with model schema', () => {
      const doc = parseOpenApiDocument({
        swaggerVersion: '1.2',
        basePath: 'http://example.com/api',
        consumes: ['application/json'],
        models: {
          Pet: {
            id: 'Pet',
            required: ['name'],
            properties: {
              id: { type: 'integer', format: 'int64' },
              name: { type: 'string' },
              tag: { type: 'string' },
            },
          },
        },
        apis: [
          {
            path: '/pets',
            operations: [
              {
                method: 'POST',
                summary: 'Create pet',
                parameters: [
                  {
                    name: 'body',
                    paramType: 'body',
                    required: true,
                    type: 'Pet',
                  },
                ],
              },
            ],
          },
        ],
      });

      const op = doc.operations[0];
      expect(op?.requestBody).toBeDefined();
      expect(op?.requestBody?.required).toBe(true);
      const schema = op?.requestBody?.content['application/json']?.schema;
      expect(schema).toMatchObject({
        type: 'object',
        required: ['name'],
        properties: {
          id: { type: 'integer', format: 'int64' },
          name: { type: 'string' },
          tag: { type: 'string' },
        },
      });
    });

    it('converts paramType: "form" parameters with type: "File" into multipart requestBody', () => {
      const doc = parseOpenApiDocument({
        swaggerVersion: '1.2',
        basePath: 'http://example.com/api',
        apis: [
          {
            path: '/upload',
            operations: [
              {
                method: 'POST',
                parameters: [
                  { name: 'file', paramType: 'form', type: 'File', required: true },
                  { name: 'note', paramType: 'form', type: 'string' },
                ],
              },
            ],
          },
        ],
      });

      const op = doc.operations[0];
      expect(op?.requestBody).toBeDefined();
      expect(Object.keys(op?.requestBody?.content ?? {})).toEqual(['multipart/form-data']);
      expect(op?.requestBody?.content['multipart/form-data']?.schema).toMatchObject({
        type: 'object',
        required: ['file'],
        properties: {
          file: { type: 'string', format: 'binary' },
          note: { type: 'string' },
        },
      });
    });

    it('supports Swagger 1.1 legacy properties: httpMethod, dataType, responseClass, and errorResponses', () => {
      const doc = parseOpenApiDocument({
        swaggerVersion: '1.1',
        basePath: 'http://example.com/api',
        apis: [
          {
            path: '/users/{id}',
            operations: [
              {
                httpMethod: 'GET',
                summary: 'Get user',
                responseClass: 'User',
                nickname: 'getUser',
                parameters: [
                  { name: 'id', paramType: 'path', dataType: 'Long' },
                ],
                errorResponses: [
                  { code: 404, reason: 'Not found' },
                ],
              },
            ],
          },
        ],
      });

      expect(doc.version).toBe('1.2');
      expect(doc.declaredVersion).toBe('Swagger 1.1');
      const op = doc.operations[0];
      expect(op?.method).toBe('get');
      expect(op?.operationId).toBe('getUser');
      expect(op?.parameters[0]).toMatchObject({
        name: 'id',
        in: 'path',
        schema: { type: 'integer', format: 'int64' },
      });
    });

    it('converts Swagger 1.2 authorizations to OpenApiSecurityScheme entries', () => {
      const doc = parseOpenApiDocument({
        swaggerVersion: '1.2',
        basePath: 'http://example.com/api',
        authorizations: {
          apiKeyAuth: {
            type: 'apiKey',
            passAs: 'header',
            keyname: 'api_key',
          },
          basicAuth: {
            type: 'basicAuth',
          },
          oauthCode: {
            type: 'oauth2',
            scopes: [
              { scope: 'write:all', description: 'Write everything' },
            ],
            grantTypes: {
              authorization_code: {
                authorizationEndpoint: { url: 'https://auth.test/auth' },
                tokenEndpoint: { url: 'https://auth.test/token' },
              },
            },
          },
        },
        apis: [],
      });

      expect(doc.securitySchemes).toHaveLength(3);
      expect(doc.securitySchemes.find((s) => s.name === 'basicAuth')).toMatchObject({
        type: 'http',
        scheme: 'basic',
      });
      expect(doc.securitySchemes.find((s) => s.name === 'apiKeyAuth')).toMatchObject({
        type: 'apiKey',
        in: 'header',
        keyName: 'api_key',
      });
      expect(doc.securitySchemes.find((s) => s.name === 'oauthCode')).toMatchObject({
        type: 'oauth2',
        flows: {
          authorizationCode: {
            authorizationUrl: 'https://auth.test/auth',
            tokenUrl: 'https://auth.test/token',
            scopes: { 'write:all': 'Write everything' },
          },
        },
      });
    });
  });
});
