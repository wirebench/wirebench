/** A REST API's stored GraphQL schema (#77): introspection and file imports become SDL in the project. */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSchema, graphqlSync, introspectionFromSchema } from 'graphql';
import { describe, expect, it } from 'vitest';
import {
  buildGraphqlSchema,
  cachedGraphqlSchema,
  graphqlSchemaPath,
  INTROSPECTION_QUERY,
  readGraphqlSchema,
  removeGraphqlSchema,
  sdlFromIntrospection,
  sdlFromSchemaFile,
  writeGraphqlSchema,
} from '../../../../src/rest/graphql/schema.js';

const SDL = 'type Query {\n  "A product by id"\n  product(id: ID!): Product\n}\n\ntype Product {\n  name: String!\n}\n';

describe('sdlFromIntrospection', () => {
  const introspection = introspectionFromSchema(buildSchema(SDL));

  it('prints the SDL of a response to the introspection query', () => {
    const sdl = sdlFromIntrospection({ data: introspection });
    expect(sdl).toContain('product(id: ID!): Product');
    expect(sdl).toContain('"""A product by id"""');
  });

  it('takes the data alone, as a file usually holds it', () => {
    expect(sdlFromIntrospection(introspection)).toBe(sdlFromIntrospection({ data: introspection }));
  });

  it('answers what a real server returns for INTROSPECTION_QUERY', () => {
    const result = graphqlSync({ schema: buildSchema(SDL), source: INTROSPECTION_QUERY });
    expect(sdlFromIntrospection(JSON.parse(JSON.stringify(result)))).toContain('type Product');
  });

  it("names the server's first error", () => {
    expect(() => sdlFromIntrospection({ errors: [{ message: 'Introspection is disabled' }] })).toThrow(
      /Introspection is disabled/,
    );
  });

  it.each([null, [], { data: {} }, 'text'])('refuses what is not an introspection result: %j', (document) => {
    expect(() => sdlFromIntrospection(document)).toThrow(/not a GraphQL introspection result/);
  });
});

describe('sdlFromSchemaFile', () => {
  it('keeps valid SDL as written', () => {
    expect(sdlFromSchemaFile(SDL, 'schema.graphqls')).toBe(SDL);
  });

  it('prints an introspection JSON file as SDL', () => {
    const json = JSON.stringify({ data: introspectionFromSchema(buildSchema(SDL)) });
    expect(sdlFromSchemaFile(json, 'schema.JSON')).toContain('type Product');
  });

  it.each([
    ['type Query {', 'does not parse'],
    ['type Query { a: Missing }', 'does not parse'],
    ['type Product { name: String }', 'not valid'],
  ])('refuses SDL that does not build: %s', (sdl, message) => {
    expect(() => sdlFromSchemaFile(sdl, 'x.graphql')).toThrow(new RegExp(message));
  });

  it('refuses a JSON file that does not parse', () => {
    expect(() => sdlFromSchemaFile('{', 'x.json')).toThrow(/not valid JSON/);
  });
});

describe('the stored schema', () => {
  it('lives under the API, and round-trips', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wb-gql-'));
    try {
      expect(graphqlSchemaPath('shop')).toBe('apis/shop/graphql/schema.graphql');
      expect(await readGraphqlSchema(dir, 'shop')).toBeUndefined();
      await writeGraphqlSchema(dir, 'shop', SDL);
      expect(await readFile(join(dir, 'apis/shop/graphql/schema.graphql'), 'utf8')).toBe(SDL);
      expect(await readGraphqlSchema(dir, 'shop')).toBe(SDL);
      await removeGraphqlSchema(dir, 'shop');
      await removeGraphqlSchema(dir, 'shop');
      expect(await readGraphqlSchema(dir, 'shop')).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses an API slug that is not one path segment', () => {
    expect(() => graphqlSchemaPath('../x')).toThrow();
  });

  it('builds a schema once per SDL text', () => {
    expect(cachedGraphqlSchema(SDL)).toBe(cachedGraphqlSchema(SDL));
    expect(cachedGraphqlSchema('type Query {')).toBeUndefined();
    expect(buildGraphqlSchema(SDL).getQueryType()?.name).toBe('Query');
  });
});
