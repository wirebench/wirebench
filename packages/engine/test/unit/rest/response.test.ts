/**
 * Reading a response: what kind of body it is, how it decodes, how it formats, and what cookies it
 * set. The cases that matter are the dishonest ones — JSON labelled `text/plain`, a charset nobody
 * supports, a malformed document the user still has to be able to look at.
 */
import { describe, expect, it } from 'vitest';
import { detectLanguage, decodeResponseText, parseSetCookie, prettyBody } from '../../../src/rest/response.js';

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

describe('detectLanguage', () => {
  it.each([
    ['application/json', '{}', 'json'],
    ['application/problem+json; charset=utf-8', '{}', 'json'],
    ['text/xml', '<a/>', 'xml'],
    ['application/soap+xml', '<a/>', 'xml'],
    ['text/html', '<p>', 'html'],
    ['application/javascript', 'let a', 'javascript'],
    ['image/png', '\x89PNG', 'image'],
    ['text/csv', 'a,b', 'text'],
    ['application/pdf', '%PDF', 'text'],
    ['application/octet-stream', '\x00\x01', 'binary'],
  ])('believes %s', (contentType, body, expected) => {
    expect(detectLanguage(contentType, bytes(body))).toBe(expected);
  });

  it.each([
    ['text/plain', '{"a":1}', 'json'],
    ['text/plain', '[1,2]', 'json'],
    ['text/plain', '<?xml version="1.0"?><a/>', 'xml'],
    ['text/plain', '<!DOCTYPE html><html>', 'html'],
    ['application/octet-stream', '{"a":1}', 'json'],
    [undefined, '{"a":1}', 'json'],
    ['text/plain', 'hello', 'text'],
  ])('sniffs past a %s label when the bytes say otherwise', (contentType, body, expected) => {
    expect(detectLanguage(contentType, bytes(body))).toBe(expected);
  });

  it('ignores a leading byte-order mark and whitespace when sniffing', () => {
    expect(detectLanguage('text/plain', bytes('﻿\n  {"a":1}'))).toBe('json');
  });

  it('calls an empty body with no type binary, not JSON', () => {
    expect(detectLanguage(undefined, new Uint8Array())).toBe('binary');
  });
});

describe('decodeResponseText', () => {
  it('decodes UTF-8 by default and strips the byte-order mark', () => {
    expect(decodeResponseText(bytes('﻿café'), 'application/json')).toEqual({ text: 'café' });
  });

  it('honours a declared charset', () => {
    expect(decodeResponseText(new Uint8Array([0x63, 0x61, 0x66, 0xe9]), 'text/plain; charset=iso-8859-1')).toEqual({
      text: 'café',
    });
  });

  it('falls back to UTF-8 with a note when the charset label is unsupported', () => {
    const result = decodeResponseText(bytes('a'), 'text/plain; charset=made-up-99');
    expect(result.text).toBe('a');
    expect(result.problem).toContain('made-up-99');
  });

  it('replaces invalid bytes instead of throwing', () => {
    expect(decodeResponseText(new Uint8Array([0xff, 0xfe, 0x41]), 'application/json').text).toContain('A');
  });
});

describe('prettyBody', () => {
  it('re-indents JSON', () => {
    expect(prettyBody('{"a":[1,2]}', 'json')).toEqual({ text: '{\n  "a": [\n    1,\n    2\n  ]\n}', changed: true });
  });

  it('returns malformed JSON unchanged, with the parser message', () => {
    const result = prettyBody('{"a":', 'json');
    expect(result.text).toBe('{"a":');
    expect(result.changed).toBe(false);
    expect(result.problem).toBeDefined();
  });

  it('formats XML through the engine pretty printer', () => {
    expect(prettyBody('<a><b>1</b></a>', 'xml').text).toBe('<a>\n  <b>1</b>\n</a>');
  });

  it('indents HTML by tag depth', () => {
    expect(prettyBody('<html><body><p>hi</p></body></html>', 'html').text).toBe(
      '<html>\n  <body>\n    <p>\n      hi\n    </p>\n  </body>\n</html>',
    );
  });

  it('leaves text, binary and image bodies alone', () => {
    for (const language of ['text', 'binary', 'image'] as const) {
      expect(prettyBody('as is', language)).toEqual({ text: 'as is', changed: false });
    }
  });

  it('reports JSON that is already formatted as unchanged', () => {
    expect(prettyBody('{\n  "a": 1\n}', 'json').changed).toBe(false);
  });
});

describe('parseSetCookie', () => {
  it('parses the attributes of a full cookie', () => {
    expect(
      parseSetCookie([
        [
          'set-cookie',
          'id=a3fWa; Expires=Thu, 21 Oct 2021 07:28:00 GMT; Path=/api; Domain=.example.test; Secure; HttpOnly; SameSite=Strict; Max-Age=3600',
        ],
      ]),
    ).toEqual([
      {
        name: 'id',
        value: 'a3fWa',
        expires: '2021-10-21T07:28:00.000Z',
        path: '/api',
        domain: 'example.test',
        secure: true,
        httpOnly: true,
        sameSite: 'Strict',
        maxAge: 3600,
      },
    ]);
  });

  it('keeps several cookies separate, and ignores other headers', () => {
    expect(
      parseSetCookie([
        ['content-type', 'application/json'],
        ['set-cookie', 'a=1'],
        ['Set-Cookie', 'b=2; Path=/'],
      ]).map((cookie) => cookie.name),
    ).toEqual(['a', 'b']);
  });

  it('unquotes a quoted value and keeps an empty one', () => {
    expect(
      parseSetCookie([
        ['set-cookie', 'a="x y"'],
        ['set-cookie', 'b='],
      ]),
    ).toEqual([
      { name: 'a', value: 'x y' },
      { name: 'b', value: '' },
    ]);
  });

  it('marks a line that is not a cookie rather than dropping the evidence', () => {
    expect(parseSetCookie([['set-cookie', 'nonsense']])).toEqual([{ name: 'nonsense', value: '', malformed: true }]);
  });

  it('keeps an unparseable Expires verbatim', () => {
    expect(parseSetCookie([['set-cookie', 'a=1; Expires=whenever']])[0]).toMatchObject({ expires: 'whenever' });
  });

  it('defaults an unknown SameSite to Lax, as browsers do', () => {
    expect(parseSetCookie([['set-cookie', 'a=1; SameSite=weird']])[0]).toMatchObject({ sameSite: 'Lax' });
  });

  it('keeps a value containing = intact', () => {
    expect(parseSetCookie([['set-cookie', 'token=ab==; Path=/']])[0]).toMatchObject({ value: 'ab==' });
  });
});
