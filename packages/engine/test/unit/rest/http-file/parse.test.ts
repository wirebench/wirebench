import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { HttpFileError } from '../../../../src/errors.js';
import { parseHttpFile } from '../../../../src/rest/http-file/parse.js';

const here = dirname(fileURLToPath(import.meta.url));

function readFixture(rel: string): string {
  return readFileSync(resolve(here, '../../../../../../fixtures', rel), 'utf8');
}

describe('parseHttpFile', () => {
  const parsed = parseHttpFile(readFixture('http-file/crafted/api.http'));

  it('reads file variables in order, keeping repeats for the mapper to report', () => {
    expect(parsed.variables.map((v) => [v.name, v.value])).toEqual([
      ['host', '{{baseUrl}}/v1'],
      ['host', 'ignored'],
      ['user', 'alice'],
    ]);
  });

  it('splits on ### and names requests from ### text or # @name', () => {
    expect(parsed.requests.map((r) => [r.name, r.method])).toEqual([
      ['List pets', 'GET'],
      ['createPet', 'POST'],
      ['Upload', 'POST'],
      [undefined, 'GET'],
      [undefined, 'WEBSOCKET'],
      [undefined, 'GRAPHQL'],
    ]);
  });

  it('joins query continuation lines onto the URL', () => {
    expect(parsed.requests[0]?.url).toBe('{{host}}/pets?limit=10&sort=name');
  });

  it('reads headers, inline body, handlers and directives', () => {
    const create = parsed.requests[1]!;
    expect(create.httpVersion).toBe('HTTP/1.1');
    expect(create.headers).toEqual([
      { name: 'Content-Type', value: 'application/json' },
      { name: 'Authorization', value: 'Bearer {{token}}' },
    ]);
    expect(create.body).toEqual({ kind: 'inline', text: '{"name": "Rex", "id": "{{$uuid}}"}' });
    expect(create.handlers).toEqual([{ kind: 'inline', text: 'client.global.set("petId", response.body.id);' }]);
    expect(create.directives).toEqual([{ name: 'no-redirect' }, { name: 'timeout', value: '5' }]);
  });

  it('reads a body from a file and counts output redirects', () => {
    expect(parsed.requests[2]?.body).toEqual({ kind: 'file', path: './photo.png' });
    expect(parsed.requests[2]?.redirects).toBe(1);
  });

  it('defaults the method to GET for a bare URL line', () => {
    expect(parseHttpFile('https://example.com/a').requests[0]).toMatchObject({
      method: 'GET',
      url: 'https://example.com/a',
    });
  });

  it('refuses more than 5,000 requests', () => {
    expect(() => parseHttpFile(Array.from({ length: 5001 }, () => 'GET https://x').join('\n###\n'))).toThrow(
      HttpFileError,
    );
  });
});
