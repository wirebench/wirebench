/**
 * The shared pieces the layered script APIs are built from. Each part is evaluated for real in a
 * `node:vm` context with stubs for the sandbox API (ruling R6), and the bindings it declares and
 * the names it passes to `define` must be exactly the ones listed, so a layer author knows which
 * names a part takes.
 */
import { createContext, runInContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { BRUNO_LAYER } from '../../../src/script/api/bruno.js';
import { HOPPSCOTCH_LAYER } from '../../../src/script/api/hoppscotch.js';
import { INSOMNIA_LAYER } from '../../../src/script/api/insomnia.js';
import { POSTMAN_LAYER } from '../../../src/script/api/postman.js';
import { THUNDER_CLIENT_LAYER } from '../../../src/script/api/thunder-client.js';
import {
  PART_CRYPTO,
  PART_EXPECT,
  PART_JEST_EXPECT,
  PART_JSON_SCHEMA,
  PART_PAIRS,
  PART_PM,
  PART_REQUEST,
  PART_RESPONSE,
  PART_UNSUPPORTED,
  PART_VARIABLES,
} from '../../../src/script/api/layer-parts.js';

const PARTS: ReadonlyArray<readonly [string, string]> = [
  ['PART_UNSUPPORTED', PART_UNSUPPORTED],
  ['PART_VARIABLES', PART_VARIABLES],
  ['PART_EXPECT', PART_EXPECT],
  ['PART_PAIRS', PART_PAIRS],
  ['PART_CRYPTO', PART_CRYPTO],
  ['PART_PM', PART_PM],
  ['PART_JSON_SCHEMA', PART_JSON_SCHEMA],
  ['PART_JEST_EXPECT', PART_JEST_EXPECT],
  ['PART_REQUEST', PART_REQUEST],
  ['PART_RESPONSE', PART_RESPONSE],
];

interface Evaluated {
  /** Every binding the part declared (let, const, function, class) that did not exist before it. */
  readonly declared: string[];
  /** The names the part passed to `define`. */
  readonly defined: string[];
}

/** A context with stand-ins for what the sandbox gives a layer before it runs. */
const makeContext = (defined: string[]) => {
  class ScriptUnsupported extends Error {}
  class ExpectationFailed extends Error {}
  return createContext({
    define: (name: string) => {
      defined.push(name);
    },
    ScriptUnsupported,
    ExpectationFailed,
    show: String,
    vars: {},
    props: {},
    crypto: {},
    encoding: {},
    request: {},
    response: {},
    input: { phase: 'pre', info: { requestName: 'x' }, request: {} },
    iteration: { index: 0, count: 1 },
    execution: {},
    test: () => undefined,
  });
};

const isBound = (ctx: object, name: string): boolean => {
  try {
    runInContext(name, ctx);
    return true;
  } catch (error) {
    // The context has its own realm, so match on the name. Keywords in a part's text are not bindings.
    const name = (error as Error).name;
    if (name === 'ReferenceError' || name === 'SyntaxError') return false;
    throw error;
  }
};

/** Run the parts before `index` as context, then the part at `index`, and report what it added. */
const evaluate = (index: number): Evaluated => {
  const defined: string[] = [];
  const ctx = makeContext(defined);
  for (const [, earlier] of PARTS.slice(0, index)) runInContext(earlier, ctx);
  defined.length = 0;
  const source = PARTS[index]![1];
  const candidates = [...new Set(source.match(/[A-Za-z_$][\w$]*/g) ?? [])];
  const before = new Map(candidates.map((name) => [name, isBound(ctx, name) ? runInContext(name, ctx) : undefined]));
  const had = new Set(candidates.filter(isBound.bind(null, ctx)));
  runInContext(source, ctx);
  const declared = candidates.filter((name) =>
    had.has(name) ? !Object.is(runInContext(name, ctx), before.get(name)) : isBound(ctx, name),
  );
  return { declared, defined: [...defined] };
};

const EXPECTED: ReadonlyArray<{ declared: string[]; defined: string[] }> = [
  { declared: ['unsupported'], defined: [] },
  { declared: ['asValue', 'variables'], defined: [] },
  { declared: ['typeName', 'same', 'chain', 'chaiExpect', 'chaiExpectSchema'], defined: [] },
  { declared: ['pairs'], defined: [] },
  {
    declared: ['Hex', 'Base64', 'Utf8', 'Latin1', 'words', 'text', 'hashOf', 'hmacOf', 'CryptoJS'],
    defined: ['CryptoJS', 'btoa', 'atob'],
  },
  { declared: ['pmExpect', 'pmRequest', 'pmResponse', 'pmObject', 'pmResponseValue'], defined: [] },
  { declared: ['jsonSchema'], defined: [] },
  { declared: ['TYPES', 'jestMatchers', 'jestExpect'], defined: [] },
  {
    declared: [
      'noPairs',
      'cannot',
      'requestHeaders',
      'noQuery',
      'requestQuery',
      'requestUrl',
      'hasMessage',
      'restBody',
      'requestBody',
      'requestText',
      'setRequestBody',
      'setRequestUrl',
      'setRequestMethod',
    ],
    defined: [],
  },
  { declared: ['responseView'], defined: [] },
];

describe('the shared layer parts', () => {
  PARTS.forEach(([name], index) => {
    it(`${name} defines only its names`, () => {
      const got = evaluate(index);
      const want = EXPECTED[index]!;
      expect([...got.declared].sort()).toEqual([...want.declared].sort());
      expect(got.defined).toEqual(want.defined);
    });
  });

  it('the parts compose in one scope with no redeclaration', () => {
    const defined: string[] = [];
    const ctx = makeContext(defined);
    expect(() => void runInContext(PARTS.map(([, part]) => part).join(''), ctx)).not.toThrow();
    expect(defined).toEqual(['CryptoJS', 'btoa', 'atob']);
  });

  it('the Postman layer runs over the parts in one scope', () => {
    const defined: string[] = [];
    const ctx = makeContext(defined);
    expect(() => void runInContext(POSTMAN_LAYER, ctx)).not.toThrow();
    expect(defined).toEqual(expect.arrayContaining(['pm', 'postman', 'CryptoJS', 'btoa', 'atob']));
  });

  it('the Insomnia layer runs over the parts in one scope', () => {
    const defined: string[] = [];
    const ctx = makeContext(defined);
    expect(() => void runInContext(INSOMNIA_LAYER, ctx)).not.toThrow();
    expect(defined).toEqual(expect.arrayContaining(['insomnia', '$', 'CryptoJS', 'btoa', 'atob']));
  });

  it('the Bruno layer runs over the parts in one scope', () => {
    const defined: string[] = [];
    const ctx = makeContext(defined);
    expect(() => void runInContext(BRUNO_LAYER, ctx)).not.toThrow();
    expect(defined).toEqual(expect.arrayContaining(['expect', 'bru', 'req', 'res', 'require']));
  });

  it('the Hoppscotch layer runs over the parts in one scope', () => {
    const defined: string[] = [];
    const ctx = makeContext(defined);
    expect(() => void runInContext(HOPPSCOTCH_LAYER, ctx)).not.toThrow();
    expect(defined).toEqual(expect.arrayContaining(['pw', 'hopp', 'pm', 'require', 'CryptoJS', 'btoa', 'atob']));
  });

  it('the Thunder Client layer runs over the parts in one scope', () => {
    const defined: string[] = [];
    const ctx = makeContext(defined);
    expect(() => void runInContext(THUNDER_CLIENT_LAYER, ctx)).not.toThrow();
    expect(defined).toEqual(expect.arrayContaining(['expect', 'tc', 'require']));
  });
});
