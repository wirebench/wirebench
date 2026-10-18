/**
 * The mapping table's test, expectation, encoding and crypto rows (spec §6.4, §6.7): every chai and
 * Jest row under each root that runs it, `tc.test`'s three forms, the CryptoJS chains, and the chains
 * and calls left as TODOs.
 */
import { describe, expect, it } from 'vitest';
import { restScriptTypes } from '../../../../src/rest/script-types.js';
import { convertScript } from '../../../../src/script/convert/index.js';
import type { ConvertProtocol } from '../../../../src/script/convert/roots.js';
import type { LayeredApi, ScriptPhase } from '../../../../src/script/model.js';
import { apiDeclarations, secretNameType } from '../../../../src/script/types/api.js';
import { typeErrors } from '../ts-check.js';

const PROTOCOLS: readonly ConvertProtocol[] = ['rest', 'soap', 'grpc', 'mcp'];
const PHASES: readonly ScriptPhase[] = ['pre', 'post'];

/** The converted script without its header line. */
function converted(dialect: LayeredApi, text: string, protocol: ConvertProtocol = 'rest', phase: ScriptPhase = 'pre') {
  const result = convertScript({ dialect, protocol, phase, text });
  if (!result.ok) throw new Error(result.message);
  return { ...result, body: result.text.slice(result.text.indexOf('\n') + 1) };
}

/** Converts `from` on every protocol and phase and checks it becomes `to` with one replacement. */
function expectEverywhere(dialect: LayeredApi, from: string, to: string, mapped = 1): void {
  for (const protocol of PROTOCOLS) {
    for (const phase of PHASES) {
      const result = converted(dialect, `${from}\n`, protocol, phase);
      expect(result.body).toBe(`${to}\n`);
      expect(result.todos).toEqual([]);
      expect(result.mapped).toBe(mapped);
    }
  }
}

/** Checks `statement` is left as written under one not-mapped TODO naming `call`. */
function expectTodo(dialect: LayeredApi, statement: string, call: string, reason = 'not converted yet'): void {
  for (const protocol of PROTOCOLS) {
    const result = converted(dialect, `${statement}\n`, protocol);
    expect(result.body).toBe(`// TODO(convert): ${call} — ${reason}\n// ${statement}\n`);
    expect(result.todos).toEqual([{ phase: 'pre', line: 2, call, kind: 'not-mapped', reason }]);
    expect(result.mapped).toBe(0);
  }
}

/** The roots whose expect has the chai chains. */
const CHAI_ROOTS: readonly (readonly [LayeredApi, string])[] = [
  ['postman', 'pm.expect'],
  ['insomnia', 'insomnia.expect'],
  ['insomnia', '$.expect'],
  ['hoppscotch', 'pm.expect'],
  ['hoppscotch', 'hopp.expect'],
  ['bruno', 'expect'],
  ['thunder-client', 'expect'],
  ['thunder-client', 'tc.expect'],
];

/** The roots whose expect has the Jest-style matchers. */
const JEST_ROOTS: readonly (readonly [LayeredApi, string])[] = [
  ['hoppscotch', 'pw.expect'],
  ['hoppscotch', 'hopp.expect'],
];

/** Each chai chain after `CALL(value)` and what it becomes after `expect(value)` (or the whole statement). */
const CHAI_ROWS: readonly (readonly [string, string])[] = [
  ['.to.equal(200)', '.toBe(200)'],
  ['.to.equals(200)', '.toBe(200)'],
  ['.to.eq(200)', '.toBe(200)'],
  ['.to.deep.equal({ a: 1 })', '.toEqual({ a: 1 })'],
  ['.to.eql({ a: 1 })', '.toEqual({ a: 1 })'],
  ['.to.eqls({ a: 1 })', '.toEqual({ a: 1 })'],
  [".to.include('a')", ".toContain('a')"],
  [".to.includes('a')", ".toContain('a')"],
  [".to.contain('a')", ".toContain('a')"],
  [".to.contains('a')", ".toContain('a')"],
  [".to.have.property('id')", ".toHaveProperty('id')"],
  [".to.have.property('id', 7)", ".toHaveProperty('id', 7)"],
  ['.to.have.lengthOf(3)', '.toHaveLength(3)'],
  ['.to.have.length(3)', '.toHaveLength(3)'],
  ['.to.match(/^a/)', '.toMatch(/^a/)'],
  ['.to.be.above(1)', '.toBeGreaterThan(1)'],
  ['.to.be.gt(1)', '.toBeGreaterThan(1)'],
  ['.to.be.greaterThan(1)', '.toBeGreaterThan(1)'],
  ['.to.be.below(1)', '.toBeLessThan(1)'],
  ['.to.be.lt(1)', '.toBeLessThan(1)'],
  ['.to.be.lessThan(1)', '.toBeLessThan(1)'],
  ['.to.be.true', '.toBe(true)'],
  ['.to.be.false', '.toBe(false)'],
  ['.to.be.null', '.toBeNull()'],
  ['.to.be.undefined', '.toBeUndefined()'],
  ['.to.be.ok', '.toBeTruthy()'],
];

/** `.a(t)` and `.an(t)` for the types typeof answers the same as chai. */
const TYPE_ROWS = ['string', 'number', 'boolean', 'undefined', 'function'].flatMap((type) => [
  [`.to.be.a('${type}')`, type] as const,
  [`.to.be.an('${type}')`, type] as const,
]);

describe('one row per chai chain', () => {
  for (const [from, to] of CHAI_ROWS) {
    it.each(CHAI_ROOTS.map(([dialect, call]) => ({ dialect, call })))(
      `$call${from} ($dialect)`,
      ({ dialect, call }) => {
        expectEverywhere(dialect, `${call}(value)${from};`, `expect(value)${to};`);
      },
    );
  }
  for (const [from, type] of TYPE_ROWS) {
    it.each(CHAI_ROOTS.map(([dialect, call]) => ({ dialect, call })))(
      `$call${from} ($dialect)`,
      ({ dialect, call }) => {
        expectEverywhere(dialect, `${call}(value)${from};`, `expect(typeof value).toBe('${type}');`);
      },
    );
  }
});

describe('one row per Jest matcher', () => {
  const rows: readonly (readonly [string, string])[] = [
    ['CALL(value).toBe(200);', 'expect(value).toBe(200);'],
    ['CALL(value).toHaveLength(3);', 'expect(value).toHaveLength(3);'],
    ["CALL(value).toInclude('a');", "expect(value).toContain('a');"],
    ["CALL(value).toBeType('string');", "expect(typeof value).toBe('string');"],
    ['CALL(value).toBeLevel2xx();', 'expect(Math.floor(value / 100)).toBe(2);'],
    ['CALL(value).toBeLevel3xx();', 'expect(Math.floor(value / 100)).toBe(3);'],
    ['CALL(value).toBeLevel4xx();', 'expect(Math.floor(value / 100)).toBe(4);'],
    ['CALL(value).toBeLevel5xx();', 'expect(Math.floor(value / 100)).toBe(5);'],
    ['CALL(value).not.toBe(200);', 'expect(value).not.toBe(200);'],
    ["CALL(value).not.toBeType('string');", "expect(typeof value).not.toBe('string');"],
    ['CALL(value).not.toBeLevel5xx();', 'expect(Math.floor(value / 100)).not.toBe(5);'],
  ];
  for (const [from, to] of rows) {
    it.each(JEST_ROOTS.map(([dialect, call]) => ({ dialect, call })))(`${from} on $call`, ({ dialect, call }) => {
      expectEverywhere(dialect, from.replace('CALL', call), to);
    });
  }

  it('pw.expect has no chai chain, and the chai roots have no Jest matcher', () => {
    expectTodo('hoppscotch', 'pw.expect(value).to.equal(1);', 'pw.expect');
    expectTodo('hoppscotch', 'pw.expect(value).equal(1);', 'pw.expect');
    expectTodo('postman', 'pm.expect(value).toBe(1);', 'pm.expect');
    expectTodo('bruno', 'expect(value).toBeLevel2xx();', 'expect');
    expectTodo('thunder-client', "tc.expect(value).toInclude('a');", 'tc.expect');
  });

  it("hopp.expect's Jest matchers are reachable through .not only, not through a chai word", () => {
    expectTodo('hoppscotch', 'hopp.expect(value).to.toBe(1);', 'hopp.expect');
    expectEverywhere('hoppscotch', 'hopp.expect(value).not.toInclude(1);', 'expect(value).not.toContain(1);');
  });
});

describe('.not placement and the dropped filler words', () => {
  it.each([
    ['pm.expect(a).to.not.equal(1);', 'expect(a).not.toBe(1);'],
    ['pm.expect(a).not.to.be.true;', 'expect(a).not.toBe(true);'],
    ['pm.expect(a).to.not.have.property("id");', 'expect(a).not.toHaveProperty("id");'],
    ['pm.expect(a).to.not.deep.equal(b);', 'expect(a).not.toEqual(b);'],
    ['pm.expect(a).to.deep.not.equal(b);', 'expect(a).not.toEqual(b);'],
    ["pm.expect(a).to.not.be.an('number');", "expect(typeof a).not.toBe('number');"],
    ['pm.expect(a).not.not.equal(1);', 'expect(a).toBe(1);'],
    ['pm.expect(a).to.be.been.is.that.which.and.has.have.with.at.of.does.equal(1);', 'expect(a).toBe(1);'],
    ['pm.expect(a).equal(1);', 'expect(a).toBe(1);'],
  ])('%s', (from, to) => {
    expectEverywhere('postman', from, to);
  });

  it.each([
    'pm.expect(a).to.be.same.equal(1);',
    'pm.expect(a).but.equal(1);',
    'pm.expect(a).to.still.equal(1);',
    'pm.expect(a).also.equal(1);',
    'pm.expect(a).to.be;',
    'pm.expect(a);',
    'pm.expect(a).to.equal(1).and.be.ok;',
    "pm.expect(a).to.have.property('b').that.equals(1);",
    'pm.expect(a).to.equal;',
    'pm.expect(a).to.be.true();',
    "pm.expect(a)['to'].equal(1);",
    'pm.expect(a)?.to.equal(1);',
    'pm.expect(a, "message").to.equal(1);',
    'pm.expect(...a).to.equal(1);',
    'pm.expect(a).to.equal(1, 2);',
    'pm.expect(a).to.deep.include(b);',
    'pm.expect(a).to.deep.property("b");',
  ])('a word or call outside the tables leaves the whole statement: %s', (statement) => {
    expectTodo('postman', statement, 'pm.expect');
  });

  it.each([
    'pm.expect(a).to.constructor(1);',
    'pm.expect(a).to.toString(1);',
    'pm.expect(a).to.hasOwnProperty(1);',
    'pm.expect(a).to.be.constructor;',
    'pm.expect(a).to.be.__proto__;',
    'pm.expect(a).to.be.valueOf;',
  ])('a chai word on the object prototype is not in the tables: %s', (statement) => {
    expectTodo('postman', statement, 'pm.expect');
  });

  it.each([
    'pw.expect(a).constructor(1);',
    'pw.expect(a).toString(1);',
    'pw.expect(a).constructor();',
    'pw.expect(a).hasOwnProperty();',
  ])('a Jest matcher on the object prototype is not in the tables: %s', (statement) => {
    expectTodo('hoppscotch', statement, 'pw.expect');
  });

  it.each([
    'pm.expect(data).to.include({ id: 1 });',
    'pm.expect(data).to.includes({ id: 1 });',
    'pm.expect(data).to.contain({ id: 1 });',
    'pm.expect(data).to.contains({ id: 1 });',
    'pm.expect(data).to.not.include({});',
    'pm.expect(data).to.include(({ id: 1 }));',
  ])('an object literal given to include or contain (a subset match) is not mapped: %s', (statement) => {
    expectTodo('postman', statement, 'pm.expect');
  });

  it('include and contain keep any other argument', () => {
    expectEverywhere('postman', 'pm.expect(data).to.include(item);', 'expect(data).toContain(item);');
    expectEverywhere('postman', 'pm.expect(data).to.contain([1]);', 'expect(data).toContain([1]);');
  });

  it('names the call as written for each root', () => {
    expectTodo('bruno', 'expect(a).to.be.empty;', 'expect');
    expectTodo('insomnia', '$.expect(a).to.be.empty;', '$.expect');
    expectTodo('hoppscotch', 'hopp.expect(a).to.be.empty;', 'hopp.expect');
  });
});

describe('.property with and without a dot', () => {
  it.each([
    ["pm.expect(a).to.have.property('id');", "expect(a).toHaveProperty('id');"],
    ['pm.expect(a).to.have.property("id", 7);', 'expect(a).toHaveProperty("id", 7);'],
    ['pm.expect(a).to.have.property(`id`);', 'expect(a).toHaveProperty(`id`);'],
    ["pm.expect(a).to.have.property('a.b');", "expect(a).toHaveProperty(['a.b']);"],
    ["pm.expect(a).to.have.property('a.b', 7);", "expect(a).toHaveProperty(['a.b'], 7);"],
    ['pm.expect(a).to.have.property(name);', 'expect(a).toHaveProperty([name]);'],
    ['pm.expect(a).to.have.property(name, value);', 'expect(a).toHaveProperty([name], value);'],
    ['pm.expect(a).to.have.property(`${k}`);', 'expect(a).toHaveProperty([`${k}`]);'],
  ])('%s', (from, to) => {
    expectEverywhere('postman', from, to);
  });

  it('takes one or two arguments', () => {
    expectTodo('postman', 'pm.expect(a).to.have.property();', 'pm.expect');
    expectTodo('postman', "pm.expect(a).to.have.property('a', 1, 2);", 'pm.expect');
  });
});

describe(".a('object') becomes a TODO", () => {
  it.each([
    "pm.expect(a).to.be.an('object');",
    "pm.expect(a).to.be.an('array');",
    "pm.expect(a).to.be.a('null');",
    "pm.expect(a).to.be.a('regexp');",
    "pm.expect(a).to.be.a('String');",
    'pm.expect(a).to.be.a(type);',
  ])('%s', (statement) => {
    expectTodo('postman', statement, 'pm.expect');
  });

  it('takes a template literal with no substitution as a string literal', () => {
    expectEverywhere('postman', 'pm.expect(a).to.be.a(`string`);', 'expect(typeof a).toBe(`string`);');
  });

  it.each([
    'pm.expect(a).to.be.oneOf([1, 2]);',
    'pm.expect(a).to.be.within(1, 2);',
    'pm.expect(a).to.be.at.least(1);',
    'pm.expect(a).to.be.gte(1);',
    'pm.expect(a).to.be.at.most(1);',
    'pm.expect(a).to.be.lte(1);',
    "pm.expect(a).to.have.keys('a', 'b');",
    'pm.expect(a).to.be.empty;',
    'pm.expect(a).to.exist;',
    'pm.expect(a).to.be.NaN;',
    "pm.expect(a).to.have.string('a');",
    'pm.expect(a).to.matches(/a/);',
  ])('the other chains §6.4 does not map: %s', (statement) => {
    expectTodo('postman', statement, 'pm.expect');
  });

  it("Bruno's .jsonSchema points at the request's JSON Schema assertion", () => {
    const reason = "the typed API has no JSON Schema check; use the request's JSON Schema assertion";
    expectTodo('bruno', 'expect(body).to.have.jsonSchema(schema);', 'expect', reason);
    expectTodo('bruno', 'expect(body).to.not.have.jsonSchema(schema);', 'expect', reason);
    // Outside Bruno it is an ordinary word with no row.
    expectTodo('thunder-client', 'expect(body).to.have.jsonSchema(schema);', 'expect');
  });
});

describe('operands are converted and kept apart', () => {
  it('converts a dialect call in the subject and in a matcher argument', () => {
    expectEverywhere(
      'postman',
      "pm.expect(pm.environment.get('a')).to.equal(pm.environment.get('b'));",
      "expect((vars.get('a') ?? props.get('a'))).toBe((vars.get('b') ?? props.get('b')));",
      3,
    );
  });

  it('parenthesises a subject that typeof or the division would split', () => {
    expectEverywhere('hoppscotch', "pw.expect(a + b).toBeType('number');", "expect(typeof (a + b)).toBe('number');");
    expectEverywhere('hoppscotch', 'pw.expect(a || b).toBeLevel4xx();', 'expect(Math.floor((a || b) / 100)).toBe(4);');
    expectEverywhere(
      'postman',
      "pm.expect(pm.environment.has('a')).to.be.a('boolean');",
      "expect(typeof ((vars.get('a') ?? props.get('a')) !== undefined)).toBe('boolean');",
      2,
    );
    expectEverywhere(
      'hoppscotch',
      "pw.expect(body.items[0].id).toBeType('number');",
      "expect(typeof body.items[0].id).toBe('number');",
    );
    expectEverywhere('hoppscotch', 'pw.expect(code()).toBeLevel2xx();', 'expect(Math.floor(code() / 100)).toBe(2);');
  });

  it('names only its own call when the chain is left, although the subject has a row', () => {
    expectTodo('postman', "pm.expect(pm.environment.get('a')).to.be.empty;", 'pm.expect');
  });

  it('leaves the statement whole when a call in an operand has no row', () => {
    expectTodo('postman', 'pm.expect(pm.unknown()).to.equal(1);', 'pm.unknown');
  });

  it('rewrites an expectation wherever it is written, not only as a statement', () => {
    expectEverywhere('bruno', 'const check = () => expect(a).to.equal(1);', 'const check = () => expect(a).toBe(1);');
  });
});

describe('test calls', () => {
  it.each([
    ['postman', 'pm.test'],
    ['insomnia', 'insomnia.test'],
    ['insomnia', '$.test'],
    ['hoppscotch', 'pm.test'],
    ['hoppscotch', 'pw.test'],
    ['hoppscotch', 'hopp.test'],
    ['bruno', 'test'],
    ['thunder-client', 'test'],
  ] as const)('%s: %s(n, f) is test(n, f)', (dialect, call) => {
    expectEverywhere(dialect, `${call}('status', () => check());`, "test('status', () => check());");
  });

  it('converts the body, and leaves a statement in it that has no row as a TODO', () => {
    const from = [
      "pm.test('ok', function () {",
      "  pm.expect(pm.environment.get('a')).to.equal(1);",
      '  pm.expect(a).to.be.empty;',
      '});',
      '',
    ].join('\n');
    const result = converted('postman', from);
    expect(result.body).toBe(
      [
        "test('ok', function () {",
        "  expect((vars.get('a') ?? props.get('a'))).toBe(1);",
        '  // TODO(convert): pm.expect — not converted yet',
        '  // pm.expect(a).to.be.empty;',
        '});',
        '',
      ].join('\n'),
    );
    expect(result.todos).toEqual([
      { phase: 'pre', line: 4, call: 'pm.expect', kind: 'not-mapped', reason: 'not converted yet' },
    ]);
    expect(result.mapped).toBe(3);
  });

  it('keeps an async callback as it is', () => {
    expectEverywhere('postman', "pm.test('a', async () => { await x; });", "test('a', async () => { await x; });");
  });

  it('takes a name and a callback', () => {
    expectTodo('postman', "pm.test('a');", 'pm.test');
    expectTodo('bruno', "test('a', f, 1);", 'test');
  });
});

describe('tc.test with a boolean, a function literal and a variable', () => {
  it.each([
    ["tc.test('ok', code === 200);", "test('ok', () => expect(code === 200).toBe(true));"],
    ["tc.test('ok', true);", "test('ok', () => expect(true).toBe(true));"],
    ["tc.test('ok', isOk());", "test('ok', () => expect(isOk()).toBe(true));"],
    [
      "tc.test('ok', () => code === 200);",
      "test('ok', () => expect<unknown>((() => code === 200)()).not.toBe(false));",
    ],
    [
      "tc.test('ok', function () { return code === 200; });",
      "test('ok', () => expect<unknown>((function () { return code === 200; })()).not.toBe(false));",
    ],
    ["tc.test('ok', (() => true));", "test('ok', () => expect<unknown>(((() => true))()).not.toBe(false));"],
    ["tc.test('ok', check);", "test('ok', () => expect<unknown>((check)()).not.toBe(false));"],
    ["tc.test('ok', checks.status);", "test('ok', () => expect<unknown>((checks.status)()).not.toBe(false));"],
  ])('%s', (from, to) => {
    expectEverywhere('thunder-client', from, to);
  });

  it.each([
    ["tc.test('ok', async () => { await x; });", "test('ok', async () => { await x; });"],
    ["tc.test('ok', async function () { await x; });", "test('ok', async function () { await x; });"],
    ["tc.test('ok', (async () => x));", "test('ok', (async () => x));"],
  ])('an async callback is the test itself, so a rejection fails it: %s', (from, to) => {
    expectEverywhere('thunder-client', from, to);
  });

  it('converts the callback body', () => {
    expectEverywhere(
      'thunder-client',
      "tc.test('ok', () => { expect(a).to.equal(1); });",
      "test('ok', () => expect<unknown>((() => { expect(a).toBe(1); })()).not.toBe(false));",
      2,
    );
  });

  it('type-checks a callback that returns nothing, a boolean or false', () => {
    const declarations = apiDeclarations('rest', 'post') + secretNameType([]) + restScriptTypes(undefined);
    const script = converted(
      'thunder-client',
      `tc.test('void', () => { expect(1).to.equal(1); });
tc.test('boolean', () => tc.response.status === 200);
tc.test('false', function () { return false; });
`,
      'rest',
      'post',
    );
    expect(script.todos).toEqual([]);
    expect(typeErrors(declarations, script.text)).toEqual([]);
  });

  it('takes a name and a value', () => {
    expectTodo('thunder-client', "tc.test('ok');", 'tc.test');
  });
});

describe('btoa and atob', () => {
  it('are encoding.base64 and encoding.fromBase64', () => {
    expectEverywhere('postman', "const t = btoa(user + ':' + pass);", "const t = encoding.base64(user + ':' + pass);");
    expectEverywhere('postman', 'const t = atob(token);', 'const t = encoding.fromBase64(token);');
  });

  it('are roots of the postman dialect only', () => {
    const result = converted('insomnia', 'const t = btoa(a) + atob(b);\n');
    expect(result.body).toBe('const t = btoa(a) + atob(b);\n');
    expect(result.mapped).toBe(0);
    expect(result.todos).toEqual([]);
  });
});

describe('CryptoJS hashes and HMACs with Hex and Base64', () => {
  it.each([
    ['MD5', 'md5'],
    ['SHA1', 'sha1'],
    ['SHA256', 'sha256'],
    ['SHA512', 'sha512'],
  ])('CryptoJS.%s', (name, algorithm) => {
    expectEverywhere(
      'postman',
      `const h = CryptoJS.${name}(a).toString();`,
      `const h = crypto.hash('${algorithm}', a);`,
    );
    expectEverywhere(
      'postman',
      `const h = CryptoJS.${name}(a).toString(CryptoJS.enc.Hex);`,
      `const h = crypto.hash('${algorithm}', a);`,
    );
    expectEverywhere(
      'postman',
      `const h = CryptoJS.${name}(a).toString(CryptoJS.enc.Base64);`,
      `const h = crypto.hash('${algorithm}', a, 'base64');`,
    );
  });

  it.each([
    ['HmacSHA1', 'sha1'],
    ['HmacSHA256', 'sha256'],
    ['HmacSHA512', 'sha512'],
  ])('CryptoJS.%s', (name, algorithm) => {
    expectEverywhere(
      'postman',
      `const s = CryptoJS.${name}(data, key).toString();`,
      `const s = crypto.hmac('${algorithm}', key, data);`,
    );
    expectEverywhere(
      'postman',
      `const s = CryptoJS.${name}(data, key).toString(CryptoJS.enc.Hex);`,
      `const s = crypto.hmac('${algorithm}', key, data);`,
    );
    expectEverywhere(
      'postman',
      `const s = CryptoJS.${name}(data, key).toString(CryptoJS.enc.Base64);`,
      `const s = crypto.hmac('${algorithm}', key, data, 'base64');`,
    );
  });

  it('converts calls inside the input and keeps the result usable', () => {
    expectEverywhere(
      'postman',
      "const h = CryptoJS.SHA256(pm.environment.get('a')).toString().toUpperCase();",
      "const h = crypto.hash('sha256', (vars.get('a') ?? props.get('a'))).toUpperCase();",
      2,
    );
  });

  it.each([
    ['const w = CryptoJS.SHA256(a);', 'CryptoJS.SHA256'],
    ['const h = CryptoJS.SHA256(a).toString(CryptoJS.enc.Utf8);', 'CryptoJS.SHA256'],
    ['const h = CryptoJS.SHA256(a).toString(encoder);', 'CryptoJS.SHA256'],
    ['const h = CryptoJS.SHA256(a, b).toString();', 'CryptoJS.SHA256'],
    ['const h = CryptoJS.HmacSHA256(a).toString();', 'CryptoJS.HmacSHA256'],
    ['const h = CryptoJS.SHA256(a).toString(CryptoJS.enc.Hex, 1);', 'CryptoJS.SHA256'],
    ['const w = CryptoJS.enc.Utf8.parse(a);', 'CryptoJS.enc.Utf8.parse'],
    ['const t = CryptoJS.enc.Base64.stringify(w);', 'CryptoJS.enc.Base64.stringify'],
  ])('%s is a TODO', (statement, call) => {
    const result = converted('postman', `${statement}\n`);
    expect(result.todos.map((todo) => [todo.call, todo.kind])).toContainEqual([call, 'not-mapped']);
    expect(result.body).toContain(`// ${statement}\n`);
    expect(result.mapped).toBe(0);
  });

  it('is a root of the postman dialect only', () => {
    const result = converted('insomnia', 'const h = CryptoJS.SHA256(a).toString();\n');
    expect(result.body).toBe('const h = CryptoJS.SHA256(a).toString();\n');
    expect(result.mapped).toBe(0);
  });
});

describe('HMAC swaps data and key', () => {
  it('passes CryptoJS (data, key) as crypto.hmac (key, data)', () => {
    expectEverywhere(
      'postman',
      "const s = CryptoJS.HmacSHA256('the message', pm.environment.get('secret')).toString(CryptoJS.enc.Base64);",
      "const s = crypto.hmac('sha256', (vars.get('secret') ?? props.get('secret')), 'the message', 'base64');",
      2,
    );
  });
});
