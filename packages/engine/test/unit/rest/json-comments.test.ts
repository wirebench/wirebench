/**
 * Comments in a JSON body (#702). What matters is that the stripped text is valid JSON carrying
 * exactly the fields left uncommented, and that nothing inside a string or a `${…}` reference is
 * ever taken for a comment.
 */
import { describe, expect, it } from 'vitest';
import { hasJsonComments, stripJsonComments, stripRestBodyComments } from '#protocol-rest/rest/json-comments';

describe('stripJsonComments', () => {
  it('returns a body with no comment exactly as it was', () => {
    const text = '{\n  "a": 1,\n  "b": [1, 2,],\n}\n';
    expect(stripJsonComments(text)).toBe(text);
    expect(stripJsonComments('')).toBe('');
  });

  it('drops a line that held only a // comment', () => {
    expect(stripJsonComments('{\n  "a": 1,\n  // "b": 2,\n  "c": 3\n}')).toBe('{\n  "a": 1,\n  "c": 3\n}');
  });

  it('removes the comma a commented-out last field leaves behind', () => {
    const stripped = stripJsonComments('{\n  "a": 1,\n  // "b": 2\n}');
    expect(stripped).toBe('{\n  "a": 1\n}');
    expect(JSON.parse(stripped)).toEqual({ a: 1 });
    expect(JSON.parse(stripJsonComments('[\n  1,\n  2,\n  // 3\n]'))).toEqual([1, 2]);
  });

  it('keeps the code before a trailing // comment', () => {
    expect(stripJsonComments('{"a": 1, // why\n"b": 2}')).toBe('{"a": 1,\n"b": 2}');
  });

  it('leaves // and /* inside strings alone', () => {
    const text = '{\n  "url": "http://example.com/a//b",\n  "glob": "/* not a comment */"\n  // gone\n}';
    expect(JSON.parse(stripJsonComments(text))).toEqual({
      url: 'http://example.com/a//b',
      glob: '/* not a comment */',
    });
  });

  it('follows escaped quotes, so a string ending in \\" does not end early', () => {
    const text = '{\n  "q": "say \\"hi\\" // still text",\n  "p": "back\\\\" // comment\n}';
    expect(JSON.parse(stripJsonComments(text))).toEqual({ q: 'say "hi" // still text', p: 'back\\' });
  });

  it('removes block comments, inline and across lines', () => {
    expect(JSON.parse(stripJsonComments('{"a": /* one */ 1}'))).toEqual({ a: 1 });
    const multi = '{\n  "a": 1,\n  /*\n  "b": 2,\n  "c": 3\n  */\n  "d": 4\n}';
    expect(stripJsonComments(multi)).toBe('{\n  "a": 1,\n  "d": 4\n}');
    expect(JSON.parse(stripJsonComments('{\n  "a": 1,\n  /* "b": 2 */\n}'))).toEqual({ a: 1 });
  });

  it('keeps tokens either side of an inline block comment apart', () => {
    expect(stripJsonComments('[1/**/,2]')).toBe('[1 ,2]');
  });

  it('strips an unterminated block comment to the end of the text', () => {
    expect(stripJsonComments('{"a": 1}\n/* left open')).toBe('{"a": 1}');
  });

  it('keeps a body’s final newline', () => {
    expect(stripJsonComments('{"a": 1}\n// end\n')).toBe('{"a": 1}\n');
  });

  it('copies a ${…} reference whole, quotes and slashes included', () => {
    const text = '{\n  "when": "${$date("YYYY/MM")}",\n  "n": ${count} // later\n}';
    expect(stripJsonComments(text)).toBe('{\n  "when": "${$date("YYYY/MM")}",\n  "n": ${count}\n}');
  });

  it('removes a reference that sits inside a comment', () => {
    expect(stripJsonComments('{\n  "a": 1\n  // "token": "${secret:api}"\n}')).toBe('{\n  "a": 1\n}');
  });

  it('handles CRLF line endings', () => {
    expect(JSON.parse(stripJsonComments('{\r\n  "a": 1,\r\n  // "b": 2\r\n}\r\n'))).toEqual({ a: 1 });
  });
});

describe('hasJsonComments', () => {
  it('is true only for a comment outside strings', () => {
    expect(hasJsonComments('{"a": 1} // x')).toBe(true);
    expect(hasJsonComments('{"u": "http://x"}')).toBe(false);
  });
});

describe('stripRestBodyComments', () => {
  it('strips a raw JSON body', () => {
    expect(stripRestBodyComments({ kind: 'raw', language: 'json', text: '{\n// x\n"a": 1}' })).toEqual({
      kind: 'raw',
      language: 'json',
      text: '{\n"a": 1}',
    });
  });

  it('leaves a raw body in another language as it is, whatever its content type', () => {
    const body = { kind: 'raw', language: 'text', contentType: 'application/json', text: '// keep' } as const;
    expect(stripRestBodyComments(body)).toBe(body);
  });

  it('strips GraphQL variables but not the query', () => {
    const body = { kind: 'graphql', query: 'query { a }', variables: '{\n  "id": 1,\n  // "x": 2\n}' } as const;
    expect(stripRestBodyComments(body)).toEqual({
      kind: 'graphql',
      query: 'query { a }',
      variables: '{\n  "id": 1\n}',
    });
  });
});
