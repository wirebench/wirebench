import { describe, expect, it } from 'vitest';
import { apiFromPostmanCollection } from '#protocol-rest/rest/postman/map';
import { parsePostmanCollection } from '#protocol-rest/rest/postman/parse';
import type { PostmanCollection } from '#protocol-rest/rest/postman/model';

type Header = { key: string; value: string; disabled?: boolean; description?: string };

function mapped(header: Header[], auth?: PostmanCollection['auth']) {
  const collection: PostmanCollection = {
    info: { name: 'Creds' },
    item: [
      {
        name: 'Call',
        request: {
          method: 'GET',
          url: { raw: 'https://api.example.com/x' },
          header,
          ...(auth !== undefined ? { auth } : {}),
        },
      },
    ],
  };
  const result = apiFromPostmanCollection(parsePostmanCollection(collection), { newId: () => 'id' });
  const request = result.api.requests[0];
  if (request === undefined) throw new Error('no request');
  return { request, warnings: result.summary.warnings ?? [], text: JSON.stringify(result) };
}

describe('Postman mapping: credential headers', () => {
  it('turns a literal bearer Authorization header into bearer auth, without its token', () => {
    const { request, warnings, text } = mapped([
      { key: 'Authorization', value: 'Bearer lit-token-123' },
      { key: 'Accept', value: 'application/json' },
    ]);
    expect(request.auth).toEqual({ type: 'bearer' });
    expect(request.headers.map((h) => h.name)).toEqual(['Accept']);
    expect(text).not.toContain('lit-token-123');
    expect(warnings).toContain('Call: the Authorization credential was not imported; set it on the request or API.');
  });

  it('keeps the user name of a literal basic header, never the password', () => {
    const { request, text } = mapped([{ key: 'Authorization', value: `Basic ${btoa('alice:lit-pass-456')}` }]);
    expect(request.auth).toEqual({ type: 'basic', username: 'alice' });
    expect(text).not.toContain(btoa('alice:lit-pass-456'));
  });

  it('drops other credential headers with a literal value and names them', () => {
    const { request, warnings, text } = mapped([
      { key: 'X-Api-Key', value: 'lit-key-789' },
      { key: 'Cookie', value: 'sid=lit-cookie-1' },
      { key: 'X-Trace', value: 'keep-me', description: 'kept with its note' },
    ]);
    expect(request.headers).toEqual([
      { name: 'X-Trace', value: 'keep-me', enabled: true, description: 'kept with its note' },
    ]);
    expect(text).not.toMatch(/lit-key-789|lit-cookie-1/);
    expect(warnings).toContain(
      'Call: the recorded value of X-Api-Key, Cookie was not imported; set it on the request.',
    );
  });

  it('keeps credential headers made only of references, switched off ones too', () => {
    const { request, warnings } = mapped([
      { key: 'Authorization', value: 'Bearer {{token}}' },
      { key: 'X-Api-Key', value: '{{apiKey}}', disabled: true },
    ]);
    expect(request.headers).toEqual([
      { name: 'Authorization', value: 'Bearer ${token}', enabled: true },
      { name: 'X-Api-Key', value: '${apiKey}', enabled: false },
    ]);
    expect(request.auth).toEqual({ type: 'inherit' });
    expect(warnings.filter((w) => w.includes('credential') || w.includes('recorded value'))).toEqual([]);
  });

  it("leaves the request's own auth as it is when a literal Authorization header is dropped", () => {
    const { request, text } = mapped([{ key: 'Authorization', value: 'Bearer lit-token-2' }], {
      type: 'apikey',
      apikey: [
        { key: 'key', value: 'X-Key' },
        { key: 'in', value: 'header' },
      ],
    });
    expect(request.auth).toMatchObject({ type: 'api-key' });
    expect(request.headers).toEqual([]);
    expect(text).not.toContain('lit-token-2');
  });
});
