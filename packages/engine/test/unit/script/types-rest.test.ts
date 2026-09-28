/**
 * REST script types from an OpenAPI operation: JSON Schema mapped to TypeScript, the response a
 * union by status that `response.status === …` narrows, and all of it compiling with a script.
 */
import { describe, expect, it } from 'vitest';
import type { OpenApiOperation } from '../../../src/rest/openapi/model.js';
import { apiDeclarations, secretNameType } from '../../../src/script/types/api.js';
import { JsonSchemaTypes } from '../../../src/script/types/json-schema.js';
import { restScriptTypes } from '../../../src/script/types/rest.js';
import { typeErrors } from './ts-check.js';

const pet: Record<string, unknown> = {
  type: 'object',
  description: 'A pet. */ not the end of the comment',
  required: ['id', 'name'],
  properties: {
    id: { type: 'integer', format: 'int64' },
    name: { type: 'string', description: 'Its name' },
    tag: { type: 'string', nullable: true },
    status: { type: 'string', enum: ['available', 'sold'] },
    'x-weird key': { type: 'boolean' },
    photos: { type: 'array', items: { type: 'string' } },
  },
};
// A shared, self-referencing node, as the parser leaves a resolved `$ref`.
(pet['properties'] as Record<string, unknown>)['parent'] = pet;

const problem = { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] };

const OPERATION: OpenApiOperation = {
  method: 'post',
  path: '/pets',
  parameters: [],
  requestBody: { content: { 'application/json': { schema: pet } } },
  responses: {
    '201': { content: { 'application/json': { schema: pet } } },
    '4XX': { content: { 'application/problem+json': { schema: problem } } },
    '404': { description: 'no body' },
  },
};

const declarations = (operation: OperationInput, phase: 'pre' | 'post' = 'post'): string =>
  apiDeclarations('rest', phase) + secretNameType(['signing-key']) + restScriptTypes(operation);
type OperationInput = OpenApiOperation | undefined;

describe('JsonSchemaTypes', () => {
  const typeOf = (schema: unknown): string => {
    const types = new JsonSchemaTypes();
    const expression = types.typeOf(schema);
    return types.declarations() + expression;
  };

  it('maps the basic keywords', () => {
    expect(typeOf({ type: 'string' })).toBe('string');
    expect(typeOf({ type: ['integer', 'null'] })).toBe('number | null');
    expect(typeOf({ enum: ['a', 1, null] })).toBe('"a" | 1 | null');
    expect(typeOf({ const: true })).toBe('true');
    expect(typeOf({ type: 'array', items: { oneOf: [{ type: 'string' }, { type: 'number' }] } })).toBe(
      '(string | number)[]',
    );
    expect(
      typeOf({
        allOf: [
          { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
          { type: 'object', properties: { b: { type: 'number' } } },
        ],
      }),
    ).toBe('{\n    a: string;\n  } & {\n    b?: number;\n  }');
    expect(typeOf({ type: 'object', additionalProperties: { type: 'number' } })).toBe(
      '{\n  [key: string]: number | undefined;\n}',
    );
    expect(typeOf({ type: 'object', additionalProperties: false })).toBe('Record<string, never>');
  });

  it('widens what it does not know to unknown', () => {
    expect(typeOf({})).toBe('unknown');
    expect(typeOf({ $ref: '#/components/schemas/Missing' })).toBe('unknown');
    expect(typeOf({ type: 'file' })).toBe('unknown');
    expect(typeOf({ enum: [{ a: 1 }] })).toBe('unknown');
    expect(typeOf('not a schema')).toBe('unknown');
  });

  it('names a cyclic node once and refers to it', () => {
    const out = typeOf(pet);
    expect(out.match(/^type WbT1 = /m)).not.toBeNull();
    expect(out).toContain('parent?: WbT1;');
    expect(out).toContain('"x-weird key"?: boolean;');
    expect(out).toContain('*\\/ not the end');
    expect(out.endsWith('WbT1')).toBe(true);
  });
});

describe('restScriptTypes', () => {
  it('compiles with the API, and narrows the response by status', () => {
    const script = `
      if (response.status === 201) {
        const pet = response.json();
        const id: number = pet.id;
        const name: string = pet.name;
        const tag: string | null | undefined = pet.tag;
        const parentName: string | undefined = pet.parent?.name;
        log(id, name, tag, parentName, pet.status === 'sold');
      } else if (response.status === 404) {
        const body: unknown = response.json();
        log(body);
      } else if (response.status === 418) {
        const title: string = response.json().title;
        log(title);
      } else if (response.status === 500) {
        const body: unknown = response.json();
        log(body);
      }
      test('created', () => expect(response.status).toBe(201));
      vars.set('id', 1, { secret: true });
      log(secrets.get('signing-key'));
    `;
    expect(typeErrors(declarations(OPERATION), script)).toEqual([]);
  });

  it('catches a wrong path, a wrong status body and an unlisted secret', () => {
    const script = `
      if (response.status === 201) { log(response.json().pett); }
      if (response.status === 404) { log(response.json().title); }
      log(secrets.get('prod-db'));
    `;
    const errors = typeErrors(declarations(OPERATION), script);
    expect(errors).toHaveLength(3);
    expect(errors[0]).toMatch(/script\.ts:2: Property 'pett' does not exist/);
    expect(errors[1]).toMatch(/script\.ts:3: .*'unknown'/);
    expect(errors[2]).toMatch(/script\.ts:4: .*"prod-db".*not assignable/);
  });

  it('types a pre-request body from the request schema', () => {
    const ok = `
      const body = request.body.json;
      request.body.json = { ...body, name: body.name.toUpperCase() };
      request.headers.set('X-A', '1');
      request.query.add('q', 'x');
      request.url = request.url + '#x';
    `;
    expect(typeErrors(declarations(OPERATION, 'pre'), ok)).toEqual([]);
    const bad = 'request.body.json = { name: 1 };\nresponse;';
    const errors = typeErrors(declarations(OPERATION, 'pre'), bad);
    expect(errors.some((e) => e.startsWith('/script.ts:1: '))).toBe(true);
    expect(errors.some((e) => e.includes("Cannot find name 'response'"))).toBe(true);
  });

  it('leaves the bodies untyped when the request has no operation', () => {
    const types = declarations(undefined);
    expect(types).toContain('not linked to an operation');
    expect(typeErrors(types, 'const body: unknown = response.json(); log(body, response.status);')).toEqual([]);
    expect(typeErrors(types, 'log(response.json().anything);')).toHaveLength(1);
  });

  it('types a default response as the rest of the statuses', () => {
    const operation: OpenApiOperation = {
      method: 'get',
      path: '/x',
      parameters: [],
      responses: {
        '200': { content: { 'application/json': { schema: { type: 'string' } } } },
        default: { content: { 'application/json': { schema: problem } } },
      },
    };
    const script = `
      if (response.status === 200) { const s: string = response.json(); log(s); }
      else { const t: string = response.json().title; log(t); }
    `;
    expect(typeErrors(declarations(operation), script)).toEqual([]);
  });
});
