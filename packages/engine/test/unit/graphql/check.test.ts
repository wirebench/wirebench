/** A GraphQL response checked (#77): its errors, and its data against the operation and the schema. */
import { buildSchema } from 'graphql';
import { describe, expect, it } from 'vitest';
import { checkGraphqlResponse, GRAPHQL_CHECK_MAX_BYTES } from '#protocol-graphql/graphql/check';

const schema = buildSchema(`
  type Query { product(id: ID!): Product, products: [Product!]!, node(id: ID!): Node, count: Int! }
  type Mutation { rename(name: String!): Product! }
  interface Node { id: ID! }
  type Product implements Node { id: ID!, name: String!, price: Float, kind: Kind, tags: [String!] }
  type Shop implements Node { id: ID!, title: String! }
  enum Kind { BOOK FILM }
`);

function check(query: string, body: unknown, operationName?: string) {
  return checkGraphqlResponse({
    query,
    bodyText: typeof body === 'string' ? body : JSON.stringify(body),
    schema,
    ...(operationName !== undefined ? { operationName } : {}),
  });
}

describe('checkGraphqlResponse', () => {
  it('passes data that matches the selection', () => {
    const result = check('{ product(id: 1) { id name price kind tags } count }', {
      data: { product: { id: '1', name: 'Book', price: 9.5, kind: 'BOOK', tags: ['a'] }, count: 3 },
    });
    expect(result).toEqual({ errors: [], problems: [], schema: 'checked' });
  });

  it('reports each error with its path and pointer', () => {
    const result = check('{ product(id: 1) { name } }', {
      data: { product: null },
      errors: [{ message: 'Not found', path: ['product'] }, { nope: true }],
    });
    expect(result.errors).toEqual([
      { message: 'Not found', path: ['product'], pointer: '/errors/0' },
      { message: 'An error with no message', pointer: '/errors/1' },
    ]);
    expect(result.problems).toEqual([]);
  });

  it('reports a missing field, an unselected one, a null non-null, a wrong scalar and a bad enum', () => {
    const result = check('{ product(id: 1) { id name price kind } count }', {
      data: { product: { id: true, name: null, price: 'cheap', kind: 'TOY', extra: 1 }, count: 1.5 },
    });
    expect(result.problems).toEqual([
      { pointer: '/data/product/id', message: 'Not a ID' },
      { pointer: '/data/product/name', message: 'null where String! is non-null' },
      { pointer: '/data/product/price', message: 'Not a Float' },
      { pointer: '/data/product/kind', message: 'Not a value of the enum Kind' },
      { pointer: '/data/product/extra', message: 'The field "extra" was not selected' },
      { pointer: '/data/count', message: 'Not a Int' },
    ]);
  });

  it('reports a missing selected field', () => {
    expect(check('{ count products { id } }', { data: { products: [] } }).problems).toEqual([
      { pointer: '/data/count', message: 'Missing the selected field "count"' },
    ]);
  });

  it('checks every item of a list, and a list that is not one', () => {
    expect(check('{ products { id } }', { data: { products: [{ id: '1' }, { id: [] }] } }).problems).toEqual([
      { pointer: '/data/products/1/id', message: 'Not a ID' },
    ]);
    expect(check('{ products { id } }', { data: { products: {} } }).problems).toEqual([
      { pointer: '/data/products', message: 'Expected a list of Product!' },
    ]);
  });

  it('uses response keys for aliases', () => {
    expect(check('{ first: product(id: 1) { title: name } }', { data: { first: { title: 'x' } } }).problems).toEqual(
      [],
    );
  });

  it('follows fragments, on the runtime type when __typename names it', () => {
    const query = `
      query { node(id: 1) { __typename id ...P ... on Shop { title } } }
      fragment P on Product { name }
    `;
    expect(check(query, { data: { node: { __typename: 'Product', id: '1', name: 'x' } } }).problems).toEqual([]);
    expect(check(query, { data: { node: { __typename: 'Shop', id: '1', name: 'x' } } }).problems).toEqual([
      { pointer: '/data/node/title', message: 'Missing the selected field "title"' },
      { pointer: '/data/node/name', message: 'The field "name" was not selected' },
    ]);
  });

  it('does not ask for a fragment field when the runtime type is unknown', () => {
    expect(check('{ node(id: 1) { id ... on Shop { title } } }', { data: { node: { id: '1' } } }).problems).toEqual([]);
  });

  it('does not ask for a field behind @include or @skip', () => {
    expect(check('{ count products @skip(if: true) { id } }', { data: { count: 1 } }).problems).toEqual([]);
  });

  it('picks the named operation of several', () => {
    const query = 'query A { count } mutation B { rename(name: "x") { name } }';
    expect(check(query, { data: { rename: { name: 'x' } } }, 'B').problems).toEqual([]);
    expect(check(query, { data: { rename: { name: 'x' } } }).schema).toBe('no-query');
  });

  it('expects nulls and gaps where a field failed', () => {
    const result = check('{ count products { id } }', { data: null, errors: [{ message: 'boom' }] });
    expect(result.problems).toEqual([]);
    expect(
      check('{ product(id: 1) { name } }', { data: { product: { name: null } }, errors: [{ message: 'x' }] }).problems,
    ).toEqual([]);
  });

  it('says what it could not check', () => {
    expect(checkGraphqlResponse({ query: '{ count }', bodyText: '{"data":{"count":1}}' }).schema).toBe('no-schema');
    expect(check('{ count', { data: { count: 1 } }).schema).toBe('no-query');
    expect(check('{ count }', '<html>').schema).toBe('not-graphql');
    expect(check('{ count }', { hello: 1 }).schema).toBe('not-graphql');
    expect(check('{ count }', 'x'.repeat(GRAPHQL_CHECK_MAX_BYTES + 1)).schema).toBe('skipped');
  });

  it('keeps errors when there is no schema', () => {
    const result = checkGraphqlResponse({ query: '{ count }', bodyText: '{"errors":[{"message":"no"}]}' });
    expect(result.errors.map((e) => e.message)).toEqual(['no']);
  });

  it('caps the problems and their messages', () => {
    const many = Array.from({ length: 80 }, () => ({ id: 1.5 }));
    expect(check('{ products { id } }', { data: { products: many } }).problems).toHaveLength(50);
    const long = check('{ count }', { errors: [{ message: 'm'.repeat(1000) }] });
    expect(long.errors[0]!.message).toHaveLength(300);
  });
});
