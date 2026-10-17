/**
 * The scripts API option of the Postman mapper: other clients' importers go through this mapper and
 * attach their scripts under their own script API.
 */
import { describe, expect, it } from 'vitest';
import { apiFromPostmanCollection, unsupportedCalls } from '../../../../src/rest/postman/map.js';
import { parsePostmanCollection } from '../../../../src/rest/postman/parse.js';

const info = { name: 'Shop', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' };
const collection = {
  info,
  event: [{ listen: 'prerequest', script: { type: 'text/javascript', exec: 'a();' } }],
  item: [
    {
      name: 'R',
      event: [{ listen: 'test', script: { type: 'text/javascript', exec: 'b();' } }],
      request: { method: 'GET', url: '/r' },
    },
  ],
};

describe('MapPostmanOptions.scriptApi', () => {
  it('scriptApi insomnia writes api insomnia, enabled false', () => {
    const { api } = apiFromPostmanCollection(parsePostmanCollection(collection), { scriptApi: 'insomnia' });
    expect(api.scripts).toEqual({ pre: { text: 'a();\n' }, api: 'insomnia', enabled: false, secrets: [] });
    expect(api.requests[0]?.scripts).toEqual({
      post: { text: 'b();\n' },
      api: 'insomnia',
      enabled: false,
      secrets: [],
    });
  });

  it('no scriptApi keeps postman', () => {
    const { api } = apiFromPostmanCollection(parsePostmanCollection(collection));
    expect(api.scripts?.api).toBe('postman');
    expect(api.requests[0]?.scripts?.api).toBe('postman');
  });

  it("the unsupported scan uses the api's list", () => {
    expect(unsupportedCalls('pm.sendRequest(x)', 'postman')).toEqual(['pm.sendRequest']);
    expect(unsupportedCalls('pm.sendRequest(x)', 'insomnia')).toEqual([]);
  });
});
