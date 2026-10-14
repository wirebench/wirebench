/** A GraphQL response's check on the REST exchange summary (#77). */
import { describe, expect, it } from 'vitest';
import { recordSecretValue } from '../src/main/redact.js';
import { toGraphqlCheckWire } from '../src/main/send/record.js';
import { graphqlCheckWireSchema } from '../src/shared/kinds/rest/wire.js';

describe('toGraphqlCheckWire', () => {
  const result = {
    schema: 'checked' as const,
    errors: [{ message: 'Token gql-secret-77 expired', path: ['product', 0], pointer: '/errors/0' }],
    problems: [{ pointer: '/data/product/price', message: 'Not a Float' }],
  };

  it('carries errors and problems as the wire schema has them', () => {
    const wire = toGraphqlCheckWire(result, true);
    expect(graphqlCheckWireSchema.parse(wire)).toEqual(wire);
    expect(wire).toEqual({
      schema: 'checked',
      errors: [{ message: 'Token gql-secret-77 expired', path: ['product', 0], pointer: '/errors/0' }],
      problems: [{ pointer: '/data/product/price', message: 'Not a Float' }],
    });
  });

  it("masks a recorded secret in an error's message unless the session shows secrets", () => {
    recordSecretValue('gql-secret-77');
    expect(toGraphqlCheckWire(result, false).errors[0]!.message).not.toContain('gql-secret-77');
    expect(toGraphqlCheckWire(result, true).errors[0]!.message).toContain('gql-secret-77');
  });
});
