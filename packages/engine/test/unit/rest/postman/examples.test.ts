import { describe, expect, it } from 'vitest';
import { REDACTED_MARKER } from '#core/redact/index';
import { apiFromPostmanCollection } from '#protocol-rest/rest/postman/map';
import { parsePostmanCollection } from '#protocol-rest/rest/postman/parse';
import type { RestRequestDef } from '#protocol-rest/rest/model';

let n = 0;
const newId = (): string => `id-${String((n += 1))}`;

function only(doc: unknown): { request: RestRequestDef; warnings: readonly string[] } {
  const mapped = apiFromPostmanCollection(parsePostmanCollection(doc), { newId });
  return { request: mapped.api.requests[0]!, warnings: mapped.summary.warnings ?? [] };
}

const SCHEMA = 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json';

describe('Postman saved responses (item.response[])', () => {
  it('imports each saved response with a status code as a request example', () => {
    const { request } = only({
      info: { name: 'C', schema: SCHEMA },
      item: [
        {
          name: 'Get user',
          request: { method: 'GET', url: 'https://api.example.com/users/1' },
          response: [
            {
              name: 'Found',
              code: 200,
              status: 'OK',
              header: [{ key: 'Content-Type', value: 'application/json' }],
              body: '{"id":1}',
            },
            { name: 'Missing', code: 404, status: 'Not Found', header: [] },
          ],
        },
      ],
    });
    expect(request.examples).toHaveLength(2);
    expect(request.examples?.[0]).toMatchObject({
      name: 'Found',
      status: 200,
      statusText: 'OK',
      contentType: 'application/json',
      body: '{"id":1}',
    });
    expect(request.examples?.[1]).toMatchObject({ name: 'Missing', status: 404, statusText: 'Not Found' });
    expect(request.examples?.[1]?.body).toBeUndefined();
  });

  it('masks credentials in a saved response and drops its cookies', () => {
    const { request, warnings } = only({
      info: { name: 'C', schema: SCHEMA },
      item: [
        {
          name: 'Login',
          request: { method: 'POST', url: 'https://api.example.com/login' },
          response: [
            {
              name: 'OK',
              code: 200,
              header: [
                { key: 'Authorization', value: 'Bearer abc' },
                { key: 'Set-Cookie', value: 'sid=1' },
                { key: 'Content-Type', value: 'application/json' },
              ],
              body: '{"token":"secret-value"}',
            },
          ],
        },
      ],
    });
    const example = request.examples?.[0];
    expect(example?.headers.map((h) => h.name)).toEqual(['Authorization', 'Content-Type']);
    expect(example?.headers[0]?.value).toBe(REDACTED_MARKER);
    expect(example?.body).not.toContain('secret-value');
    expect(warnings).toContain('Login: credentials in a saved response were masked in its example');
  });

  it('skips a saved response without a numeric code and says so', () => {
    const { request, warnings } = only({
      info: { name: 'C', schema: SCHEMA },
      item: [
        {
          name: 'Ping',
          request: { method: 'GET', url: 'https://api.example.com/ping' },
          response: [{ name: 'Odd', status: 'OK' }, 'not a record'],
        },
      ],
    });
    expect(request.examples).toBeUndefined();
    expect(warnings).toContain('Ping: 2 saved responses without a status code were skipped');
  });

  it('cuts a body past 256 KB', () => {
    const { request, warnings } = only({
      info: { name: 'C', schema: SCHEMA },
      item: [
        {
          name: 'Big',
          request: { method: 'GET', url: 'https://api.example.com/big' },
          response: [
            {
              name: 'OK',
              code: 200,
              header: [{ key: 'Content-Type', value: 'text/plain' }],
              body: 'x'.repeat(300 * 1024),
            },
          ],
        },
      ],
    });
    expect(request.examples?.[0]?.body).toHaveLength(256 * 1024);
    expect(warnings).toContain('Big: a 200 example body was larger than 256 KB and was cut');
  });
});

describe('Postman saved responses: content type and request settings', () => {
  it('takes a saved body type from _postman_previewlanguage when no header names one', () => {
    const { request } = only({
      info: { name: 'C', schema: SCHEMA },
      item: [
        {
          name: 'X',
          request: { method: 'GET', url: 'https://api.example.com/x' },
          response: [
            { name: 'json', code: 200, header: [], body: '{}', _postman_previewlanguage: 'json' },
            { name: 'odd', code: 200, header: [], body: 'x', _postman_previewlanguage: 'constructor' },
          ],
        },
      ],
    });
    expect(request.examples?.[0]?.contentType).toBe('application/json');
    expect(request.examples?.[1]?.contentType).toBeUndefined();
  });

  it('takes the redirect settings of protocolProfileBehavior', () => {
    const { request } = only({
      info: { name: 'C', schema: SCHEMA },
      item: [
        {
          name: 'X',
          request: { method: 'GET', url: 'https://api.example.com/x' },
          protocolProfileBehavior: { followRedirects: false, maxRedirects: 3, strictSSL: false },
        },
      ],
    });
    expect(request.settings).toEqual({ followRedirects: false, maxRedirects: 3 });
  });
});
