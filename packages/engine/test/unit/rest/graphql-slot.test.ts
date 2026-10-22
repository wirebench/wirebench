/**
 * REST's GraphQL slot (phase 6 spec §3.2): REST stores a GraphQL body, the composition installs what
 * it means. A build that composed no GraphQL refuses the body with `feature-disabled`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.resetModules();
});

const body = { kind: 'graphql', query: '{ a }', variables: '' } as const;

describe('the GraphQL slot', () => {
  it('refuses a GraphQL body when nothing installed GraphQL', async () => {
    vi.resetModules();
    const { restGraphql } = await import('#protocol-rest/rest/graphql-slot');
    const { encodeRestBody } = await import('#protocol-rest/rest/body');
    expect(() => restGraphql()).toThrow(expect.objectContaining({ code: 'feature-disabled' }));
    await expect(encodeRestBody(body)).rejects.toMatchObject({
      code: 'feature-disabled',
      details: { feature: 'graphql' },
    });
  });

  it('lowers it through what the composition installed', async () => {
    vi.resetModules();
    await import('../../../src/protocols.js');
    const { encodeRestBody } = await import('#protocol-rest/rest/body');
    const encoded = await encodeRestBody(body);
    expect(new TextDecoder().decode(encoded.bytes)).toBe('{"query":"{ a }"}');
    expect(encoded.contentType).toContain('application/json');
  });
});
