/** The GraphQL editor's language features, answered in main (#77). */
import { buildSchema } from 'graphql';
import { describe, expect, it } from 'vitest';
import {
  graphqlDiagnostics,
  graphqlHover,
  graphqlQueryCompletion,
  graphqlVariableCompletion,
} from '../src/main/kinds/rest/graphql-assist.js';

const schema = buildSchema(`
  type Query {
    "A product by id"
    product(id: ID!, currency: Currency): Product
  }
  type Product { name: String!, price: Float }
  enum Currency { EUR GBP }
`);

const QUERY = 'query P($id: ID!, $currency: Currency) {\n  product(id: $id, currency: $currency) {\n    name\n  }\n}';

describe('graphqlDiagnostics', () => {
  it('marks what the schema does not allow, 1-based', () => {
    const { query } = graphqlDiagnostics(schema, { query: '{ product(id: 1) { nam } }' });
    expect(query).toEqual([
      {
        severity: 'error',
        message: expect.stringContaining('Cannot query field "nam"') as string,
        range: { startLine: 1, startColumn: 20, endLine: 1, endColumn: 24 },
      },
    ]);
  });

  it('marks a syntax error with no schema', () => {
    expect(graphqlDiagnostics(undefined, { query: '{ product(' }).query[0]).toMatchObject({
      severity: 'error',
      message: expect.stringContaining('Syntax Error') as string,
    });
  });

  it('names the operations of the document', () => {
    expect(
      graphqlDiagnostics(schema, { query: 'query A { product(id: 1) { name } } query B { product(id: 2) { name } }' })
        .operations,
    ).toEqual(['A', 'B']);
  });

  it('marks a missing required variable, an unknown one, and a value of the wrong type', () => {
    const variables = '{\n  "currency": "USD",\n  "extra": 1\n}';
    expect(graphqlDiagnostics(schema, { query: QUERY, variables }).variables).toEqual([
      {
        severity: 'warning',
        message: 'The operation declares no variable $extra',
        range: { startLine: 3, startColumn: 3, endLine: 3, endColumn: 10 },
      },
      {
        severity: 'error',
        message: expect.stringContaining('"$id"') as string,
        range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 2 },
      },
      {
        severity: 'error',
        message: expect.stringContaining('"$currency"') as string,
        range: { startLine: 2, startColumn: 3, endLine: 2, endColumn: 13 },
      },
    ]);
  });

  it('asks for a required variable when there are none, and leaves a reference to the send', () => {
    expect(graphqlDiagnostics(schema, { query: QUERY, variables: '' }).variables).toHaveLength(1);
    expect(graphqlDiagnostics(schema, { query: QUERY, variables: '{"id": ${petId}}' }).variables).toEqual([]);
  });

  it('marks variables that are not a JSON object, with or without a schema', () => {
    expect(graphqlDiagnostics(undefined, { query: '{ a }', variables: '[1]' }).variables[0]?.message).toBe(
      'The variables must be a JSON object',
    );
    expect(graphqlDiagnostics(undefined, { query: '{ a }', variables: '{' }).variables[0]?.message).toBe(
      'The variables are not valid JSON',
    );
  });
});

describe('completion and hover', () => {
  it("completes a type's fields", () => {
    const items = graphqlQueryCompletion(schema, '{ product(id: 1) { n } }', 1, 21);
    expect(items.map((item) => item.label)).toContain('name');
    expect(items.find((item) => item.label === 'name')).toMatchObject({ kind: 'field', detail: 'String!' });
  });

  it('completes nothing without a schema', () => {
    expect(graphqlQueryCompletion(undefined, '{ }', 1, 3)).toEqual([]);
  });

  it("completes the operation's variables as JSON keys", () => {
    expect(graphqlVariableCompletion({ query: QUERY })).toEqual([
      { label: 'id', kind: 'variable', detail: 'ID!', insertText: '"id": ' },
      { label: 'currency', kind: 'variable', detail: 'Currency', insertText: '"currency": ' },
    ]);
  });

  it("shows a field's description on hover", () => {
    expect(graphqlHover(schema, '{ product(id: 1) { name } }', 1, 4)).toContain('A product by id');
    expect(graphqlHover(undefined, '{ product }', 1, 4)).toBeNull();
  });
});
