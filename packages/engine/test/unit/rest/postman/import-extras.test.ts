import { describe, expect, it } from 'vitest';
import { folderRequests } from '../../../../src/rest/model.js';
import type { RestRequestDef } from '../../../../src/rest/model.js';
import { apiFromPostmanCollection } from '../../../../src/rest/postman/map.js';
import { parsePostmanCollection } from '../../../../src/rest/postman/parse.js';

const info = { name: 'C', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' };

function onlyRequest(item: Record<string, unknown>): RestRequestDef {
  const { api } = apiFromPostmanCollection(parsePostmanCollection({ info, item: [{ name: 'R', ...item }] }));
  return folderRequests(api)[0]!;
}

// What other importers write into the v2.1 document beyond Postman's own fields.
describe('Postman mapper: fields importers write', () => {
  it('a bearer scheme attribute becomes the scheme', () => {
    const request = onlyRequest({
      request: {
        method: 'GET',
        url: '/x',
        auth: {
          type: 'bearer',
          bearer: [
            { key: 'token', value: 't' },
            { key: 'scheme', value: 'Token' },
          ],
        },
      },
    });
    expect(request.auth).toEqual({ type: 'bearer', scheme: 'Token' });
  });

  it('disableUrlEncoding switches encodeUrl off', () => {
    const request = onlyRequest({
      request: { method: 'GET', url: '/x' },
      protocolProfileBehavior: { disableUrlEncoding: true },
    });
    expect(request.settings.encodeUrl).toBe(false);
  });

  it('a GraphQL operationName is kept', () => {
    const request = onlyRequest({
      request: {
        method: 'POST',
        url: '/graphql',
        body: { mode: 'graphql', graphql: { query: 'query Q { a }', variables: '', operationName: 'Q' } },
      },
    });
    expect(request.body).toEqual({ kind: 'graphql', query: 'query Q { a }', variables: '', operationName: 'Q' });
  });
});
