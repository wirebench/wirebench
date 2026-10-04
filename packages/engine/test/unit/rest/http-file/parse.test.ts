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

  it('parses a line with a very long whitespace run in linear time', () => {
    const started = performance.now();
    const result = parseHttpFile(`GET a${' '.repeat(100_000)}b`);
    expect(performance.now() - started).toBeLessThan(500);
    expect(result.requests).toHaveLength(1);
    expect(result.requests[0]?.method).toBe('GET');
  });

  it('keeps a space inside the URL and still splits off the version', () => {
    expect(parseHttpFile('GET https://x/a b HTTP/1.1').requests[0]).toMatchObject({
      url: 'https://x/a b',
      httpVersion: 'HTTP/1.1',
    });
  });

  it('does not treat a lowercase word as a method', () => {
    expect(parseHttpFile('get https://x/a').requests).toHaveLength(0);
  });

  it('skips junk lines that are neither a method line nor a URL', () => {
    const result = parseHttpFile('Content-Type: application/json\nGET https://x/a');
    expect(result.requests.map((r) => r.url)).toEqual(['https://x/a']);
  });

  describe('hostile lines', () => {
    const run = ' '.repeat(100_000);
    // `\u2028` is whitespace to `\s` but not matched by `.`, the pair that made `\s*(.*)$` quadratic.
    const tails = ['x y', 'x\u2028y'];
    const shapes: [string, (tail: string) => string][] = [
      ['a file variable', (tail) => `@a =${run}${tail}`],
      ['a file variable with the run before =', (tail) => `@a${run}${tail}`],
      ['a @name comment', (tail) => `# @name${run}${tail}`],
      ['a directive comment', (tail) => `# @timeout${run}${tail}`],
      ['a request line', (tail) => `GET${run}${tail}`],
      ['a header', (tail) => `GET https://x\nAccept:${run}${tail}`],
      ['a query continuation', (tail) => `GET https://x\n${run}${tail}`],
      ['a handler opening', (tail) => `GET https://x\n\n> {%${run}${tail}`],
      ['a one-line handler', (tail) => `GET https://x\n\n> {%${run}${tail} %}${run}${tail}`],
      ['a handler file', (tail) => `GET https://x\n\n>${run}${tail}`],
      ['a redirect', (tail) => `GET https://x\n\n>>${run}${tail}`],
      ['a body file', (tail) => `GET https://x\n\n<${run}${tail}`],
      ['a body file after the headers', (tail) => `GET https://x\nA: b\n<${run}${tail}`],
    ];
    for (const [shape, text] of shapes) {
      for (const tail of tails) {
        it(`parses ${shape} with a long space run before ${JSON.stringify(tail)} in under 200 ms`, () => {
          const input = text(tail);
          const started = performance.now();
          parseHttpFile(input);
          expect(performance.now() - started).toBeLessThan(200);
        });
      }
    }
  });

  it('reads a response handler that follows the headers with no blank line', () => {
    const [request] = parseHttpFile(
      'GET https://x\nAccept: a\n> {%\nclient.global.set("t", response.body.t);\n%}',
    ).requests;
    expect(request?.headers).toEqual([{ name: 'Accept', value: 'a' }]);
    expect(request?.handlers).toEqual([{ kind: 'inline', text: 'client.global.set("t", response.body.t);' }]);
    expect(request?.ignoredLines).toEqual([]);
  });

  it('reads a body file that follows the headers with no blank line', () => {
    const [request] = parseHttpFile('POST https://x\nContent-Type: application/json\n< ./body.json').requests;
    expect(request?.body).toEqual({ kind: 'file', path: './body.json' });
    expect(request?.headers).toEqual([{ name: 'Content-Type', value: 'application/json' }]);
  });

  it('reads a one-line handler, a handler file and a redirect that follow the headers', () => {
    expect(parseHttpFile('GET https://x\nA: b\n> {% client.log(1); %}').requests[0]?.handlers).toEqual([
      { kind: 'inline', text: 'client.log(1);' },
    ]);
    expect(parseHttpFile('GET https://x\nA: b\n> ./after.js').requests[0]?.handlers).toEqual([
      { kind: 'file', text: './after.js' },
    ]);
    expect(parseHttpFile('GET https://x\nA: b\n>> out.json').requests[0]?.redirects).toBe(1);
  });

  it('records a line among the headers that is not a header, rather than dropping it silently', () => {
    const [request] = parseHttpFile('GET https://x\nAccept: a\nnot a header\nB: c').requests;
    expect(request?.headers.map((h) => h.name)).toEqual(['Accept', 'B']);
    expect(request?.ignoredLines).toEqual([3]);
  });

  it('keeps a directive only when whitespace or the end of the line follows its name', () => {
    expect(parseHttpFile('# @timeout 5\nGET https://x').requests[0]?.directives).toEqual([
      { name: 'timeout', value: '5' },
    ]);
    expect(parseHttpFile('# @no-redirect\nGET https://x').requests[0]?.directives).toEqual([{ name: 'no-redirect' }]);
    expect(parseHttpFile('# @foo!bar\nGET https://x').requests[0]?.directives).toEqual([]);
  });
});
