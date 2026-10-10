/**
 * A mock's dispatch script checked against its API (#352): the request, the operation's responses by
 * name, the scenarios and the shared helpers — and nothing a request script has besides.
 */
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { checkOnce } from '../../../src/script/check/service.js';
import { dispatchDeclarations } from '../../../src/script/types/dispatch.js';

const DECLARATIONS = dispatchDeclarations(['ok', 'not found', 'ok']);

function codes(source: string, declarations = DECLARATIONS): number[] {
  return checkOnce({ source, declarations, api: 'wirebench' }).map((d) => d.code);
}

describe('a dispatch script', () => {
  it('may use the whole dispatch API', () => {
    const source = [
      "const id = request.pathParams['id'] ?? request.query['id']?.[0] ?? '';",
      "const auth = request.headers.find(([name]) => name.toLowerCase() === 'authorization')?.[1];",
      "log(request.operation, request.method, request.path, request.body.length, auth, crypto.hash('sha256', id));",
      'console.info(encoding.base64(id), crypto.randomUUID());',
      "if (scenarios.get('cart') === 'Started') scenarios.set('cart', 'filled');",
      'const first = responses[0];',
      'if (first !== undefined) respond(first.name);',
      "respond(id === '' ? 'not found' : 'ok');",
    ].join('\n');
    expect(checkOnce({ source, declarations: DECLARATIONS, api: 'wirebench' })).toEqual([]);
  });

  it('may not name a response the operation does not have', () => {
    const [found] = checkOnce({ source: "respond('gone');", declarations: DECLARATIONS, api: 'wirebench' });
    expect(found).toMatchObject({ line: 1, column: 9, code: 2345, severity: 'error' });
    expect(found?.message).toContain('WbResponseName');
    expect(codes("respond('ok');", dispatchDeclarations([]))).toEqual([2345]);
  });

  it('reports a misspelt global or a wrong request field', () => {
    expect(codes("respnd('ok');")).toEqual([2552]);
    expect(codes('log(request.bodyy);')).toEqual([2551]);
  });

  it('has none of what only a request script has', () => {
    expect(codes("vars.set('a', '1');")).toEqual([2304]);
    expect(codes("secrets.get('a');")).toEqual([2304]);
    expect(codes("test('a', () => undefined);")).toEqual([2593]);
  });

  it('declares only globals the dispatch prelude defines', async () => {
    const prelude = await readFile(new URL('../../../src/mock/script.ts', import.meta.url), 'utf8');
    const declared = [...DECLARATIONS.matchAll(/^declare (?:const|function) (\w+)/gm)].map((m) => m[1]);
    expect(declared.sort()).toEqual([
      'console',
      'crypto',
      'encoding',
      'log',
      'request',
      'respond',
      'responses',
      'scenarios',
    ]);
    for (const name of declared) {
      expect(prelude).toContain(`define('${String(name)}'`);
    }
  });
});
