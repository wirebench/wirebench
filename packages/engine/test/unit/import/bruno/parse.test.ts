import { describe, expect, it } from 'vitest';
import { BrunoError } from '../../../../src/errors.js';
import { block, blocks, parseBru } from '../../../../src/import/bruno/parse.js';
import type { BruBlock, BruPair } from '../../../../src/import/bruno/model.js';

function dict(b: BruBlock | undefined): readonly BruPair[] {
  if (b?.kind !== 'dict') throw new Error(`not a dictionary: ${b?.kind ?? 'absent'}`);
  return b.pairs;
}

function text(b: BruBlock | undefined): string {
  if (b?.kind !== 'text') throw new Error(`not a text block: ${b?.kind ?? 'absent'}`);
  return b.text;
}

function failure(run: () => unknown): BrunoError {
  try {
    run();
  } catch (error) {
    if (error instanceof BrunoError) return error;
    throw error;
  }
  throw new Error('expected a BrunoError');
}

describe('parseBru', () => {
  it('reads dictionary pairs, trimmed, keeping every ":" after the first', () => {
    const file = parseBru(
      'meta {\n  name: Create user\n  seq: 2\n}\n\npost {\n  url: http://host:8080/x?a=b\n  body: json\n}\n',
      'request',
      'create.bru',
    );
    expect(dict(block(file, 'meta')).map((p) => [p.key, p.value])).toEqual([
      ['name', 'Create user'],
      ['seq', '2'],
    ]);
    expect(dict(block(file, 'post'))[0]).toMatchObject({ key: 'url', value: 'http://host:8080/x?a=b', enabled: true });
  });

  it('takes up to two leading spaces off each line of a text block', () => {
    const file = parseBru('body:json {\n  {\n    "a": 1\n  }\n}\n', 'request', 'x.bru');
    expect(text(block(file, 'body:json'))).toBe('{\n  "a": 1\n}');
  });

  it('ends a block only at a line starting with "}", so an indented one stays in a script', () => {
    const script = 'script:pre-request {\n  if (x) {\n    y();\n  }\n}\ndocs {\n  hi\n}\n';
    const file = parseBru(script, 'request', 'x.bru');
    expect(text(block(file, 'script:pre-request'))).toBe('if (x) {\n  y();\n}');
    expect(text(block(file, 'docs'))).toBe('hi');
  });

  it("takes four characters off each line of a ''' value, then trims it", () => {
    const file = parseBru("headers {\n  X-Long: '''\n    line one\n      line two\n  '''\n}\n", 'request', 'x.bru');
    expect(dict(block(file, 'headers'))[0]?.value).toBe('line one\n  line two');
  });

  it("keeps what follows the closing ''' in the value, for a content type", () => {
    const file = parseBru(
      "body:multipart-form {\n  note: '''\n    hello\n  ''' @contentType(text/plain)\n}\n",
      'request',
      'x.bru',
    );
    expect(dict(block(file, 'body:multipart-form'))[0]?.value).toBe('hello @contentType(text/plain)');
  });

  it('reads a quoted key with ":" and \\" in it', () => {
    const file = parseBru('headers {\n  "x: \\"odd\\" key": v\n}\n', 'request', 'x.bru');
    expect(dict(block(file, 'headers'))[0]).toMatchObject({ key: 'x: "odd" key', value: 'v' });
  });

  it('marks ~key and ~"key" disabled', () => {
    const file = parseBru('headers {\n  ~X-Debug: 1\n  ~"my key": 2\n  On: 3\n}\n', 'request', 'x.bru');
    expect(dict(block(file, 'headers')).map((p) => [p.key, p.enabled])).toEqual([
      ['X-Debug', false],
      ['my key', false],
      ['On', true],
    ]);
  });

  it('attaches annotation lines to the next pair', () => {
    const file = parseBru(
      "vars:pre-request {\n  @number\n  timeout: 30\n  @description('''\n    some text\n  ''')\n  baseUrl: https://api.example.com\n  @description('short')\n  plain: x\n}\n",
      'folder',
      'collection.bru',
    );
    const pairs = dict(block(file, 'vars:pre-request'));
    expect(pairs.map((p) => [p.key, p.annotations])).toEqual([
      ['timeout', [{ name: 'number' }]],
      ['baseUrl', [{ name: 'description', arg: 'some text' }]],
      ['plain', [{ name: 'description', arg: 'short' }]],
    ]);
  });

  it('reads @local: value as a pair, not an annotation', () => {
    const file = parseBru('vars:post-response {\n  @token: res.body.token\n}\n', 'request', 'x.bru');
    expect(dict(block(file, 'vars:post-response'))[0]).toMatchObject({ key: '@token', value: 'res.body.token' });
  });

  it('leaves multipart @file(…) and a trailing @contentType(…) in the value', () => {
    const file = parseBru(
      'body:multipart-form {\n  avatar: @file(a.png|b.png) @contentType(image/png)\n}\n',
      'request',
      'x.bru',
    );
    expect(dict(block(file, 'body:multipart-form'))[0]?.value).toBe('@file(a.png|b.png) @contentType(image/png)');
  });

  it('reads a list value one item per line', () => {
    const file = parseBru('meta {\n  name: x\n  tags: [\n    smoke\n    regression\n  ]\n}\n', 'request', 'x.bru');
    expect(dict(block(file, 'meta'))[1]).toMatchObject({ key: 'tags', list: ['smoke', 'regression'] });
  });

  it('reads an environment: vars, a secret list with ~, color and extends', () => {
    const file = parseBru(
      'vars {\n  baseUrl: http://localhost\n  ~debug: true\n}\nvars:secret [\n  clientSecret,\n  ~old\n]\ncolor: #ff0000\nextends: Base\n',
      'environment',
      'environments/Local.bru',
    );
    expect(dict(block(file, 'vars')).map((p) => [p.key, p.enabled])).toEqual([
      ['baseUrl', true],
      ['debug', false],
    ]);
    expect(block(file, 'vars:secret')).toMatchObject({
      kind: 'list',
      items: [
        { value: 'clientSecret', enabled: true },
        { value: 'old', enabled: false },
      ],
    });
    expect(text(block(file, 'color'))).toBe('#ff0000');
    expect(text(block(file, 'extends'))).toBe('Base');
  });

  it('reads a one-line secret list', () => {
    const file = parseBru('vars:secret [ a, b ]\n', 'environment', 'e.bru');
    expect(block(file, 'vars:secret')).toMatchObject({ items: [{ value: 'a' }, { value: 'b' }] });
  });

  it('reads \\r\\n line endings', () => {
    const file = parseBru('meta {\r\n  name: x\r\n}\r\nbody:text {\r\n  a\r\n  b\r\n}\r\n', 'request', 'x.bru');
    expect(dict(block(file, 'meta'))[0]?.value).toBe('x');
    expect(text(block(file, 'body:text'))).toBe('a\nb');
  });

  it('keeps every block of a repeated name, in order', () => {
    const file = parseBru(
      'body:ws {\n  name: one\n  content: a\n}\nbody:ws {\n  name: two\n  content: b\n}\n',
      'request',
      'x.bru',
    );
    expect(blocks(file, 'body:ws').map((b) => dict(b)[0]?.value)).toEqual(['one', 'two']);
  });

  it('reads assert keys with spaces and brackets', () => {
    const file = parseBru('assert {\n  res.body[0].id: eq 1\n  res.headers["x y"]: isDefined\n}\n', 'request', 'x.bru');
    expect(dict(block(file, 'assert')).map((p) => [p.key, p.value])).toEqual([
      ['res.body[0].id', 'eq 1'],
      ['res.headers["x y"]', 'isDefined'],
    ]);
  });

  it('fails on a "//" line in a dictionary, naming the file and line', () => {
    const error = failure(() => parseBru('headers {\n  a: 1\n  // note\n}\n', 'request', 'users/get.bru'));
    expect(error.code).toBe('bruno-parse-error');
    expect(error.details).toEqual({ file: 'users/get.bru', line: 3 });
    expect(error.message).toContain('users/get.bru, line 3');
  });

  it('fails on an unclosed block and on a stray "}"', () => {
    expect(failure(() => parseBru('meta {\n  name: x\n', 'request', 'x.bru')).details).toEqual({
      file: 'x.bru',
      line: 1,
    });
    expect(failure(() => parseBru('}\n', 'request', 'x.bru')).code).toBe('bruno-parse-error');
  });

  it('fails on a top-level list outside an environment file', () => {
    expect(failure(() => parseBru('vars:secret [ a ]\n', 'request', 'x.bru')).code).toBe('bruno-parse-error');
  });
});
