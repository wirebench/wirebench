/**
 * The equivalence harness's cases (spec §12): small layered scripts that, between them, use every
 * row of the mapping table (`mappings.ts`) and every chain and matcher `chains.ts` reads, each on a
 * protocol where the row maps and in the phase it supports. A row with several call names has one
 * representative per dialect family. The inputs are ones where the layered and the typed behaviour
 * should agree; the documented differences (spec §6) are cases of their own in the test file.
 */
import type { ConvertProtocol } from '../../../../src/script/convert/roots.js';
import type { LayeredApi, ScriptPhase } from '../../../../src/script/model.js';

/** A test whose name ends in `fails` fails in both runs; every other one passes in both. */
export interface EquivalenceCase {
  /** The rows the case covers. */
  readonly name: string;
  readonly dialect: LayeredApi;
  readonly protocol: ConvertProtocol;
  readonly phase: ScriptPhase;
  readonly source: string;
}

/** Inputs every case runs with: a run value, a property, an iteration and its data row. */
export const RUN_VALUES = { seen: 'from-run' } as const;
export const RUN_PROPS = { base: 'from-props' } as const;
export const RUN_DATA = { col: 'cell' } as const;
export const RUN_ITERATION = { index: 2, count: 5 } as const;

// --- how each dialect family writes a test -------------------------------------------------------

/** How a dialect family writes a test that one value equals another. */
interface Family {
  readonly dialect: LayeredApi;
  readonly label: string;
  readonly check: (label: string, actual: string, expected: unknown) => string;
  /** The same with deep equality. */
  readonly deep: (label: string, actual: string, expected: unknown) => string;
}

const chai =
  (testCall: string, expectCall: string): Family['check'] =>
  (label, actual, expected) =>
    `${testCall}(${JSON.stringify(label)}, () => { ${expectCall}(${actual}).to.equal(${JSON.stringify(expected)}); });`;
const chaiDeep =
  (testCall: string, expectCall: string): Family['check'] =>
  (label, actual, expected) =>
    `${testCall}(${JSON.stringify(label)}, () => { ${expectCall}(${actual}).to.eql(${JSON.stringify(expected)}); });`;
const jest =
  (testCall: string, expectCall: string): Family['check'] =>
  (label, actual, expected) =>
    `${testCall}(${JSON.stringify(label)}, () => { ${expectCall}(${actual}).toBe(${JSON.stringify(expected)}); });`;

/** A family whose test and expect calls are chai-style. */
const chaiFamily = (dialect: LayeredApi, label: string, testCall: string, expectCall: string): Family => ({
  dialect,
  label,
  check: chai(testCall, expectCall),
  deep: chaiDeep(testCall, expectCall),
});

const POSTMAN = chaiFamily('postman', 'pm', 'pm.test', 'pm.expect');
const INSOMNIA = chaiFamily('insomnia', 'insomnia', 'insomnia.test', 'insomnia.expect');
const HOPP_PM = chaiFamily('hoppscotch', "Hoppscotch's pm", 'pm.test', 'pm.expect');
const HOPP: Family = {
  dialect: 'hoppscotch',
  label: 'pw and hopp',
  check: jest('pw.test', 'pw.expect'),
  deep: chaiDeep('hopp.test', 'hopp.expect'),
};
const BRUNO = chaiFamily('bruno', 'res and req', 'test', 'expect');
const TC = chaiFamily('thunder-client', 'tc', 'test', 'expect');

// --- variables (§6.3) ----------------------------------------------------------------------------

const VARIABLES: readonly EquivalenceCase[] = [
  {
    name: 'pm scopes: set',
    dialect: 'postman',
    protocol: 'rest',
    phase: 'pre',
    source: `pm.environment.set('a', 'x');
pm.collectionVariables.set('b', 3);
pm.globals.set('c', true);
pm.variables.set('d', 'y');`,
  },
  {
    name: 'insomnia scopes: set, under both roots',
    dialect: 'insomnia',
    protocol: 'grpc',
    phase: 'post',
    source: `insomnia.environment.set('a', 'x');
$.baseEnvironment.set('b', 'y');
insomnia.parentFolders.set('c', 'z');`,
  },
  {
    name: "Hoppscotch's pm scopes: set",
    dialect: 'hoppscotch',
    protocol: 'soap',
    phase: 'pre',
    source: `pm.environment.set('a', 'x');
pm.variables.set('b', 2);`,
  },
  {
    name: 'bru.setVar, setEnvVar with options, setGlobalEnvVar',
    dialect: 'bruno',
    protocol: 'mcp',
    phase: 'pre',
    source: `bru.setVar('a', 'x');
bru.setEnvVar('b', 'y', { persist: true });
bru.setGlobalEnvVar('c', 1);`,
  },
  {
    name: 'tc.setVar with and without a scope',
    dialect: 'thunder-client',
    protocol: 'rest',
    phase: 'post',
    source: `tc.setVar('a', 'x');
tc.setVar('b', 'y', 'global');`,
  },
  {
    name: 'pw.env.set, hopp.env[.active|.global].set',
    dialect: 'hoppscotch',
    protocol: 'rest',
    phase: 'post',
    source: `pw.env.set('a', 'x');
hopp.env.set('b', 'y');
hopp.env.active.set('c', 'z');
hopp.env.global.set('d', 'w');`,
  },
  {
    name: 'postman.setEnvironmentVariable, setGlobalVariable',
    dialect: 'postman',
    protocol: 'soap',
    phase: 'post',
    source: `postman.setEnvironmentVariable('a', 'x');
postman.setGlobalVariable('b', 'y');`,
  },
  {
    name: 'pm scopes: get from the run and from props',
    dialect: 'postman',
    protocol: 'rest',
    phase: 'post',
    source: [
      POSTMAN.check('environment.get', "pm.environment.get('seen')", 'from-run'),
      POSTMAN.check('variables.get', "pm.variables.get('base')", 'from-props'),
      POSTMAN.check('collectionVariables.get', "pm.collectionVariables.get('seen')", 'from-run'),
      POSTMAN.check('globals.get', "pm.globals.get('base')", 'from-props'),
      POSTMAN.check('missing', "pm.environment.get('missing')", undefined),
    ].join('\n'),
  },
  {
    name: 'insomnia scopes: get',
    dialect: 'insomnia',
    protocol: 'rest',
    phase: 'pre',
    source: [
      INSOMNIA.check('environment.get', "insomnia.environment.get('seen')", 'from-run'),
      INSOMNIA.check('baseEnvironment.get', "$.baseEnvironment.get('base')", 'from-props'),
      INSOMNIA.check('parentFolders.get', "insomnia.parentFolders.get('seen')", 'from-run'),
    ].join('\n'),
  },
  {
    name: "Hoppscotch's pm scopes: get",
    dialect: 'hoppscotch',
    protocol: 'grpc',
    phase: 'pre',
    source: [
      HOPP_PM.check('environment.get', "pm.environment.get('seen')", 'from-run'),
      HOPP_PM.check('variables.get', "pm.variables.get('base')", 'from-props'),
    ].join('\n'),
  },
  {
    name: 'bru get calls',
    dialect: 'bruno',
    protocol: 'rest',
    phase: 'post',
    source: [
      BRUNO.check('getVar', "bru.getVar('seen')", 'from-run'),
      BRUNO.check('getEnvVar', "bru.getEnvVar('base')", 'from-props'),
      BRUNO.check('getGlobalEnvVar', "bru.getGlobalEnvVar('seen')", 'from-run'),
      BRUNO.check('getCollectionVar', "bru.getCollectionVar('base')", 'from-props'),
      BRUNO.check('getFolderVar', "bru.getFolderVar('seen')", 'from-run'),
      BRUNO.check('getRequestVar', "bru.getRequestVar('base')", 'from-props'),
      "bru.setVar('copy', String(bru.getVar('seen')));",
    ].join('\n'),
  },
  {
    name: 'tc.getVar',
    dialect: 'thunder-client',
    protocol: 'grpc',
    phase: 'pre',
    source: [
      TC.check('run value', "tc.getVar('seen')", 'from-run'),
      TC.check('property', "tc.getVar('base')", 'from-props'),
    ].join('\n'),
  },
  {
    name: 'pw.env.get',
    dialect: 'hoppscotch',
    protocol: 'mcp',
    phase: 'post',
    source: [
      HOPP.check('run value', "pw.env.get('seen')", 'from-run'),
      HOPP.check('property', "pw.env.get('base')", 'from-props'),
    ].join('\n'),
  },
  {
    name: 'postman.getEnvironmentVariable, getGlobalVariable',
    dialect: 'postman',
    protocol: 'grpc',
    phase: 'pre',
    source: [
      POSTMAN.check('getEnvironmentVariable', "postman.getEnvironmentVariable('seen')", 'from-run'),
      POSTMAN.check('getGlobalVariable', "postman.getGlobalVariable('base')", 'from-props'),
    ].join('\n'),
  },
  {
    name: 'hopp.env[.active|.global].getRaw, a missing name is null',
    dialect: 'hoppscotch',
    protocol: 'rest',
    phase: 'pre',
    source: [
      HOPP.check('getRaw', "hopp.env.getRaw('seen')", 'from-run'),
      HOPP.check('active.getRaw', "hopp.env.active.getRaw('base')", 'from-props'),
      HOPP.check('global.getRaw of a missing name', "hopp.env.global.getRaw('missing')", null),
      "pw.env.set('raw', String(hopp.env.global.getRaw('missing')));",
    ].join('\n'),
  },
  {
    name: 'pm scopes: has',
    dialect: 'postman',
    protocol: 'mcp',
    phase: 'pre',
    source: `pm.environment.set('h1', pm.environment.has('seen'));
pm.environment.set('h2', pm.variables.has('base'));
pm.environment.set('h3', pm.globals.has('missing'));
if (!pm.collectionVariables.has('missing')) pm.environment.set('h4', 'absent');`,
  },
  {
    name: 'bru.hasVar',
    dialect: 'bruno',
    protocol: 'soap',
    phase: 'post',
    source: `bru.setVar('h1', bru.hasVar('seen'));
bru.setVar('h2', bru.hasVar('missing'));`,
  },
];

// --- run control and iteration (§6.7) ------------------------------------------------------------

const RUN_CONTROL: readonly EquivalenceCase[] = [
  {
    name: 'pm.execution.setNextRequest',
    dialect: 'postman',
    protocol: 'rest',
    phase: 'post',
    source: `pm.execution.setNextRequest('Next');`,
  },
  {
    name: 'postman.setNextRequest',
    dialect: 'postman',
    protocol: 'grpc',
    phase: 'pre',
    source: `postman.setNextRequest(null);`,
  },
  {
    name: 'insomnia.execution.setNextRequest',
    dialect: 'insomnia',
    protocol: 'rest',
    phase: 'pre',
    source: `insomnia.execution.setNextRequest('Next');`,
  },
  {
    name: 'bru.setNextRequest',
    dialect: 'bruno',
    protocol: 'soap',
    phase: 'post',
    source: `bru.setNextRequest('Next');`,
  },
  {
    name: 'pm.execution.skipRequest',
    dialect: 'postman',
    protocol: 'rest',
    phase: 'pre',
    source: `pm.execution.skipRequest();`,
  },
  {
    name: 'insomnia.execution.skipRequest',
    dialect: 'insomnia',
    protocol: 'rest',
    phase: 'pre',
    source: `$.execution.skipRequest();`,
  },
  {
    name: 'bru.runner.skipRequest',
    dialect: 'bruno',
    protocol: 'grpc',
    phase: 'pre',
    source: `bru.runner.skipRequest();`,
  },
  { name: 'tc.skipRequest', dialect: 'thunder-client', protocol: 'mcp', phase: 'pre', source: `tc.skipRequest();` },
  {
    name: 'bru.runner.stopExecution',
    dialect: 'bruno',
    protocol: 'rest',
    phase: 'post',
    source: `bru.runner.stopExecution();`,
  },
  {
    name: 'pm.info.iteration, iterationCount, pm.iterationData.get',
    dialect: 'postman',
    protocol: 'rest',
    phase: 'pre',
    source: `pm.environment.set('i', pm.info.iteration);
pm.environment.set('n', pm.info.iterationCount);
${POSTMAN.check('iterationData.get', "pm.iterationData.get('col')", 'cell')}`,
  },
  {
    name: 'insomnia.info.iteration, iterationCount, iterationData.get',
    dialect: 'insomnia',
    protocol: 'rest',
    phase: 'post',
    source: `insomnia.environment.set('i', insomnia.info.iteration);
insomnia.environment.set('n', $.info.iterationCount);
${INSOMNIA.check('iterationData.get', "insomnia.iterationData.get('col')", 'cell')}`,
  },
  {
    // Hoppscotch's pm has no iterationData: the layer refuses it, so Convert leaves it a TODO.
    name: "Hoppscotch's pm.info.iteration, iterationCount",
    dialect: 'hoppscotch',
    protocol: 'grpc',
    phase: 'post',
    source: `pm.environment.set('i', pm.info.iteration);
pm.environment.set('n', pm.info.iterationCount);`,
  },
  {
    name: 'tc.info.currentIteration, totalIterations',
    dialect: 'thunder-client',
    protocol: 'soap',
    phase: 'pre',
    source: `tc.setVar('i', tc.info.currentIteration);
tc.setVar('n', tc.info.totalIterations);`,
  },
];

// --- encoding and crypto (§6.7) ------------------------------------------------------------------

const CRYPTO: readonly EquivalenceCase[] = [
  {
    name: 'btoa, atob, every CryptoJS digest and HMAC in each encoding',
    dialect: 'postman',
    protocol: 'rest',
    phase: 'pre',
    source: `pm.environment.set('b64', btoa('hi there'));
pm.environment.set('raw', atob('aGkgdGhlcmU='));
pm.environment.set('md5', CryptoJS.MD5('x').toString());
pm.environment.set('sha1', CryptoJS.SHA1('x').toString(CryptoJS.enc.Hex));
pm.environment.set('sha256', CryptoJS.SHA256('x').toString(CryptoJS.enc.Base64));
pm.environment.set('sha512', CryptoJS.SHA512(String(pm.environment.get('seen'))).toString());
pm.environment.set('hmac1', CryptoJS.HmacSHA1('data', 'key').toString());
pm.environment.set('hmac256', CryptoJS.HmacSHA256('data', 'key').toString(CryptoJS.enc.Base64));
pm.environment.set('hmac512', CryptoJS.HmacSHA512('data', 'key').toString(CryptoJS.enc.Hex));`,
  },
];

// --- tests and expectations (§6.4) ---------------------------------------------------------------

/** One chain or matcher: an assertion that passes and one that fails, with `E` for the expect call. */
type Assertion = readonly [label: string, passes: string, fails: string];

/** The chai chains (spec §6.4), with each matcher's aliases. */
const CHAI: readonly Assertion[] = [
  ['equal', 'E(1).to.equal(1)', 'E(1).to.equal(2)'],
  ['equals', "E('a').equals('a')", "E('a').equals('b')"],
  ['eq', 'E(1).to.be.eq(1)', 'E(1).to.eq(3)'],
  ['deep.equal', 'E({ a: 1, b: [1] }).to.deep.equal({ a: 1, b: [1] })', 'E({ a: 1 }).to.deep.equal({ a: 2 })'],
  ['eql', 'E([1, { a: 2 }]).to.eql([1, { a: 2 }])', 'E([1]).to.eql([2])'],
  ['eqls', 'E({ a: 1 }).eqls({ a: 1 })', 'E({ a: 1 }).eqls({ a: 3 })'],
  ['include on a string', "E('hello').to.include('ell')", "E('hello').to.include('xyz')"],
  ['contain on an array', 'E([1, 2]).to.contain(2)', 'E([1, 2]).to.contain(3)'],
  ['includes', "E('abc').includes('b')", "E('abc').includes('z')"],
  ['contains', 'E([1]).contains(1)', 'E([1]).contains(2)'],
  ['property', "E({ a: 1 }).to.have.property('a')", "E({ a: 1 }).to.have.property('z')"],
  ['property with a value', "E({ a: 1 }).to.have.property('a', 1)", "E({ a: 1 }).to.have.property('a', 2)"],
  [
    'property with a dotted name',
    "E({ 'b.c': 2 }).to.have.property('b.c', 2)",
    "E({ b: { c: 2 } }).to.have.property('b.c')",
  ],
  ['lengthOf', 'E([1, 2]).to.have.lengthOf(2)', 'E([1, 2]).to.have.lengthOf(3)'],
  ['length', "E('abc').to.have.length(3)", "E('abc').to.have.length(2)"],
  ['match', "E('abc').to.match(/b/)", "E('abc').to.match(/z/)"],
  ['above', 'E(2).to.be.above(1)', 'E(1).to.be.above(1)'],
  ['gt', 'E(2).to.be.gt(1)', 'E(0).to.be.gt(1)'],
  ['greaterThan', 'E(2).greaterThan(1)', 'E(1).greaterThan(2)'],
  ['below', 'E(1).to.be.below(2)', 'E(2).to.be.below(2)'],
  ['lt', 'E(1).to.be.lt(2)', 'E(3).to.be.lt(2)'],
  ['lessThan', 'E(1).lessThan(2)', 'E(2).lessThan(1)'],
  ['true', 'E(true).to.be.true', 'E(false).to.be.true'],
  ['false', 'E(false).to.be.false', 'E(true).to.be.false'],
  ['null', 'E(null).to.be.null', 'E(0).to.be.null'],
  ['undefined', 'E(undefined).to.be.undefined', 'E(null).to.be.undefined'],
  ['ok', "E('x').to.be.ok", 'E(0).to.be.ok'],
  ["a('string')", "E('s').to.be.a('string')", "E(1).to.be.a('string')"],
  ["an('number')", "E(1).to.be.an('number')", "E('1').to.be.an('number')"],
  ["a('boolean')", "E(true).to.be.a('boolean')", "E(1).to.be.a('boolean')"],
  ["a('undefined')", "E(undefined).to.be.a('undefined')", "E(null).to.be.a('undefined')"],
  ["a('function')", "E(() => 1).to.be.a('function')", "E(1).to.be.a('function')"],
  ['not before the assertion', 'E(1).to.not.equal(2)', 'E(1).to.not.equal(1)'],
  ['not at the front', 'E([1]).not.to.include(2)', 'E([1]).not.to.include(1)'],
];

/** The Jest-style matchers (spec §6.4). */
const JEST: readonly Assertion[] = [
  ['toBe', 'E(1).toBe(1)', 'E(1).toBe(2)'],
  ['toHaveLength', 'E([1, 2]).toHaveLength(2)', 'E([1, 2]).toHaveLength(1)'],
  ['toInclude on a string', "E('abc').toInclude('b')", "E('abc').toInclude('z')"],
  ['toInclude on an array', 'E([1, 2]).toInclude(2)', 'E([1, 2]).toInclude(3)'],
  ['toBeType', "E('s').toBeType('string')", "E(1).toBeType('string')"],
  ['toBeLevel2xx', 'E(204).toBeLevel2xx()', 'E(404).toBeLevel2xx()'],
  ['toBeLevel3xx', 'E(301).toBeLevel3xx()', 'E(200).toBeLevel3xx()'],
  ['toBeLevel4xx', 'E(404).toBeLevel4xx()', 'E(500).toBeLevel4xx()'],
  ['toBeLevel5xx', 'E(503).toBeLevel5xx()', 'E(404).toBeLevel5xx()'],
  ['not', 'E(1).not.toBe(2)', 'E(1).not.toBe(1)'],
  ['not with a level', 'E(200).not.toBeLevel5xx()', 'E(500).not.toBeLevel5xx()'],
];

/** A script with a passing and a failing test per assertion, under `test` and `expect` as named. */
const assertions = (testCall: string, expectCall: string, list: readonly Assertion[]): string =>
  list
    .flatMap(([label, passes, fails]) => [
      `${testCall}(${JSON.stringify(`${label} passes`)}, function () { ${passes.replace('E(', `${expectCall}(`)}; });`,
      `${testCall}(${JSON.stringify(`${label} fails`)}, () => { ${fails.replace('E(', `${expectCall}(`)}; });`,
    ])
    .join('\n');

const EXPECTATIONS: readonly EquivalenceCase[] = [
  {
    name: 'pm.test, pm.expect chai',
    dialect: 'postman',
    protocol: 'rest',
    phase: 'post',
    source: assertions('pm.test', 'pm.expect', CHAI),
  },
  {
    name: 'insomnia.test, insomnia.expect chai',
    dialect: 'insomnia',
    protocol: 'rest',
    phase: 'pre',
    source: assertions('insomnia.test', 'insomnia.expect', CHAI),
  },
  {
    name: '$.test, $.expect',
    dialect: 'insomnia',
    protocol: 'rest',
    phase: 'post',
    source: assertions('$.test', '$.expect', CHAI.slice(0, 4)),
  },
  {
    name: "Hoppscotch's pm.test, pm.expect chai",
    dialect: 'hoppscotch',
    protocol: 'grpc',
    phase: 'post',
    source: assertions('pm.test', 'pm.expect', CHAI),
  },
  {
    name: 'hopp.test, hopp.expect chai',
    dialect: 'hoppscotch',
    protocol: 'grpc',
    phase: 'pre',
    source: assertions('hopp.test', 'hopp.expect', CHAI),
  },
  {
    name: 'hopp.test, hopp.expect Jest-style',
    dialect: 'hoppscotch',
    protocol: 'soap',
    phase: 'post',
    source: assertions('hopp.test', 'hopp.expect', JEST),
  },
  {
    name: 'pw.test, pw.expect Jest-style',
    dialect: 'hoppscotch',
    protocol: 'mcp',
    phase: 'post',
    source: assertions('pw.test', 'pw.expect', JEST),
  },
  {
    name: "Bruno's test, expect chai",
    dialect: 'bruno',
    protocol: 'soap',
    phase: 'pre',
    source: assertions('test', 'expect', CHAI),
  },
  {
    name: "Thunder Client's test, expect chai",
    dialect: 'thunder-client',
    protocol: 'rest',
    phase: 'pre',
    source: assertions('test', 'expect', CHAI),
  },
  {
    name: 'tc.expect chai',
    dialect: 'thunder-client',
    protocol: 'mcp',
    phase: 'post',
    source: assertions('test', 'tc.expect', CHAI.slice(0, 8)),
  },
  {
    name: 'tc.test with a function literal, a function variable and a value',
    dialect: 'thunder-client',
    protocol: 'rest',
    phase: 'post',
    source: `tc.test('arrow true', () => tc.response.status === 200);
tc.test('arrow fails', () => tc.response.status === 404);
tc.test('function, no return', function () { tc.setVar('ran', 'yes'); });
tc.test('function fails', function () { return false; });
const check = () => tc.response.status === 200;
tc.test('variable', check);
tc.test('value true', tc.response.status === 200);
tc.test('value fails', tc.response.status === 404);`,
  },
];

// --- the response and the request (§6.5, §6.6) ---------------------------------------------------

/** The values each protocol's snapshots hold, as a script reads them (`snapshots.ts`). */
interface Seen {
  readonly status?: number;
  /** The JSON body's `id`, or the whole text for SOAP. */
  readonly body?: string;
  readonly text?: string;
  /** A response header (gRPC metadata) and its value. */
  readonly header?: readonly [string, string];
  readonly durationMs: number;
  readonly url: string;
  readonly method?: string;
  /** A request header (gRPC metadata) and its value. */
  readonly requestHeader?: readonly [string, string];
}

const SEEN: Readonly<Record<ConvertProtocol, Seen>> = {
  rest: {
    status: 200,
    body: '9',
    text: '{"id":"9","items":2}',
    header: ['x-server', 'carts-1'],
    durationMs: 4,
    url: 'https://shop.test/carts/7?full=1',
    method: 'POST',
    requestHeader: ['x-trace', '1'],
  },
  soap: {
    status: 200,
    body: '<Envelope/>',
    text: '<Envelope/>',
    header: ['content-type', 'text/xml'],
    durationMs: 5,
    url: 'https://soap.test/stock',
    requestHeader: ['x-trace', '1'],
  },
  grpc: {
    status: 0,
    body: '9',
    text: '{"id":"9","items":2}',
    header: ['x-server', 'carts-1'],
    durationMs: 3,
    url: 'grpc.test:443',
    method: 'shop.Carts/Get',
    requestHeader: ['x-trace', '1'],
  },
  mcp: { durationMs: 6, url: 'https://mcp.test/mcp', method: 'tools/call' },
};

/** A response read: the snippet per family, and which of `Seen`'s values it gives. */
type Read = readonly [family: Family, snippet: string, seen: (seen: Seen) => unknown];

const status = (s: Seen): unknown => s.status;
/** A body read ending in `.id`: on REST that `id`; on SOAP the text, on gRPC the whole message. */
const bodyRead = (family: Family, snippet: string): Read => [family, snippet, (s) => s.body];

const RESPONSE_READS: readonly Read[] = [
  [POSTMAN, 'pm.response.code', status],
  [INSOMNIA, 'insomnia.response.code', status],
  [HOPP_PM, 'pm.response.code', status],
  [BRUNO, 'res.status', status],
  [BRUNO, 'res.getStatus()', status],
  [HOPP, 'pw.response.status', status],
  [HOPP, 'hopp.response.statusCode', status],
  [TC, 'tc.response.status', status],
  // the JSON body, which a SOAP response has not
  bodyRead(POSTMAN, 'pm.response.json().id'),
  bodyRead(INSOMNIA, '$.response.json().id'),
  bodyRead(HOPP_PM, 'pm.response.json().id'),
  bodyRead(HOPP, 'hopp.response.body.asJSON().id'),
  bodyRead(TC, 'tc.response.json.id'),
  // the body as the layer gives it: JSON parsed, else the text
  bodyRead(BRUNO, 'res.body.id'),
  bodyRead(BRUNO, 'res.getBody().id'),
  bodyRead(HOPP, 'pw.response.body.id'),
  [POSTMAN, 'pm.response.text()', (s) => s.text],
  [INSOMNIA, 'insomnia.response.text()', (s) => s.text],
  [HOPP_PM, 'pm.response.text()', (s) => s.text],
  [HOPP, 'hopp.response.body.asText()', (s) => s.text],
  [TC, 'tc.response.text', (s) => s.text],
  [POSTMAN, "pm.response.headers.get('H')", (s) => s.header?.[1]],
  [INSOMNIA, "insomnia.response.headers.get('H')", (s) => s.header?.[1]],
  [HOPP_PM, "pm.response.headers.get('H')", (s) => s.header?.[1]],
  [BRUNO, "res.getHeader('H')", (s) => s.header?.[1]],
  [TC, "tc.response.getHeader('H')", (s) => s.header?.[1]],
  [POSTMAN, 'pm.response.responseTime', (s) => s.durationMs],
  [INSOMNIA, 'insomnia.response.responseTime', (s) => s.durationMs],
  [HOPP_PM, 'pm.response.responseTime', (s) => s.durationMs],
  [BRUNO, 'res.responseTime', (s) => s.durationMs],
  [BRUNO, 'res.getResponseTime()', (s) => s.durationMs],
  [HOPP, 'hopp.response.responseTime', (s) => s.durationMs],
  [TC, 'tc.response.time', (s) => s.durationMs],
];

/** The rows of the response table each protocol maps (spec §6.5): the `—` cells are left out. */
function mapsOnResponse(snippet: string, protocol: ConvertProtocol): boolean {
  if (protocol === 'mcp') return /responseTime|response\.time|getResponseTime/.test(snippet);
  const json = /json|asJSON/.test(snippet);
  if (protocol === 'soap' && json) return false;
  return true;
}

/** The header a protocol's response has, for the `'H'` in a snippet. */
const onProtocol = (snippet: string, seen: Seen): string => snippet.replace("'H'", `'${seen.header?.[0] ?? ''}'`);

/** The gRPC response message: the typed one may be absent, so its `.id` is not read on its own. */
const GRPC_MESSAGE = { id: '9', items: 2 };

const FAMILIES: readonly Family[] = [POSTMAN, INSOMNIA, HOPP_PM, BRUNO, HOPP, TC];
const PROTOCOLS: readonly ConvertProtocol[] = ['rest', 'soap', 'grpc', 'mcp'];

/**
 * A case per family and protocol with every response read it maps there. `pm.response` on gRPC is
 * read by Hoppscotch's `pm` too: only `pm.request` fails there.
 */
const RESPONSE: readonly EquivalenceCase[] = FAMILIES.flatMap((family) =>
  PROTOCOLS.flatMap((protocol): EquivalenceCase[] => {
    const seen = SEEN[protocol];
    const lines = RESPONSE_READS.filter(([f, snippet]) => f === family && mapsOnResponse(snippet, protocol)).map(
      ([, snippet, value]) => {
        const actual = onProtocol(snippet, seen);
        if (!actual.endsWith('.id') || protocol === 'rest') return family.check(actual, actual, value(seen));
        // On SOAP a body read gives the text; on gRPC the whole message is compared.
        const body = actual.slice(0, -'.id'.length);
        return protocol === 'soap' ? family.check(body, body, seen.body) : family.deep(body, body, GRPC_MESSAGE);
      },
    );
    if (lines.length === 0) return [];
    if (family.dialect === 'postman' || family.dialect === 'insomnia' || family === HOPP_PM) {
      if (protocol !== 'mcp') {
        const code = String(seen.status);
        const root = family.dialect === 'insomnia' ? 'insomnia' : 'pm';
        lines.push(`${root}.test('status assertion, arrow body', () => ${root}.response.to.have.status(${code}));`);
        lines.push(`${root}.test('status assertion, statement', () => { ${root}.response.to.have.status(${code}); });`);
        lines.push(`${root}.test('status assertion fails', () => { ${root}.response.to.have.status(201); });`);
      }
    }
    return [
      {
        name: `${family.label} response on ${protocol}`,
        dialect: family.dialect,
        protocol,
        phase: 'post',
        source: lines.join('\n'),
      },
    ];
  }),
);

/** `pm.request` fails on gRPC in every `pm`-shaped layer (a documented difference). */
const pmOnGrpc = (family: Family, protocol: ConvertProtocol): boolean =>
  protocol === 'grpc' && (family === POSTMAN || family === INSOMNIA || family === HOPP_PM);

/** Header and URL and method reads, in both phases. */
const REQUEST_READS: readonly (readonly [Family, string, (s: Seen) => unknown, readonly ConvertProtocol[]])[] = [
  [POSTMAN, "pm.request.headers.get('x-trace')", (s) => s.requestHeader?.[1], ['rest', 'soap']],
  [INSOMNIA, "insomnia.request.headers.get('X-Trace')", (s) => s.requestHeader?.[1], ['rest', 'soap']],
  [HOPP_PM, "pm.request.headers.get('x-trace')", (s) => s.requestHeader?.[1], ['rest', 'soap']],
  [BRUNO, "req.getHeader('X-Trace')", (s) => s.requestHeader?.[1], ['rest', 'soap', 'grpc']],
  [BRUNO, 'req.getUrl()', (s) => s.url, ['rest', 'soap', 'grpc', 'mcp']],
  // On SOAP the pm-shaped layers give 'undefined' (no url), so the row leaves SOAP a TODO.
  [POSTMAN, 'pm.request.url.toString()', (s) => s.url, ['rest', 'mcp']],
  [INSOMNIA, 'insomnia.request.url.toString()', (s) => s.url, ['rest', 'mcp']],
  [HOPP_PM, 'pm.request.url.toString()', (s) => s.url, ['rest', 'mcp']],
  [BRUNO, 'req.getMethod()', (s) => s.method, ['rest', 'grpc', 'mcp']],
  [POSTMAN, 'pm.request.method', (s) => s.method, ['rest', 'mcp']],
  [INSOMNIA, '$.request.method', (s) => s.method, ['rest', 'mcp']],
  [HOPP_PM, 'pm.request.method', (s) => s.method, ['rest', 'mcp']],
];

const REQUEST_READ_CASES: readonly EquivalenceCase[] = FAMILIES.flatMap((family) =>
  PROTOCOLS.flatMap((protocol) =>
    (['pre', 'post'] as const).flatMap((phase): EquivalenceCase[] => {
      const lines = REQUEST_READS.filter(([f, , , on]) => f === family && on.includes(protocol)).map(
        ([, snippet, value]) => family.check(snippet, snippet, value(SEEN[protocol])),
      );
      if (lines.length === 0 || pmOnGrpc(family, protocol)) return [];
      return [
        {
          name: `${family.label} request reads on ${protocol}, ${phase}`,
          dialect: family.dialect,
          protocol,
          phase,
          source: lines.join('\n'),
        },
      ];
    }),
  ),
);

/** The header writes (pre-request only), compared by the request each run leaves. */
const HEADER_WRITES: readonly (readonly [Family, string])[] = [
  [
    POSTMAN,
    `pm.request.headers.add({ key: 'x-tenant', value: 'acme' });
pm.request.headers.upsert({ key: 'X-Trace', value: '2' });
pm.request.headers.upsert({ key: 'x-new', value: 'n' });
pm.request.headers.remove('Content-Type');`,
  ],
  [
    INSOMNIA,
    `insomnia.request.headers.add({ key: 'x-tenant', value: 'acme' });
$.request.headers.upsert({ key: 'X-Trace', value: '2' });
insomnia.request.headers.remove('content-type');`,
  ],
  [
    HOPP_PM,
    `pm.request.headers.add({ key: 'x-tenant', value: 'acme' });
pm.request.headers.upsert({ value: '2', key: 'x-trace' });
pm.request.headers.remove('Content-Type');`,
  ],
  [
    BRUNO,
    `req.setHeader('x-tenant', 'acme');
req.setHeader('X-Trace', '2');
req.deleteHeader('content-type');`,
  ],
  [
    HOPP,
    `hopp.request.setHeader('x-tenant', 'acme');
hopp.request.setHeader('x-trace', '2');
hopp.request.removeHeader('Content-Type');`,
  ],
];

const REQUEST_WRITE_CASES: readonly EquivalenceCase[] = HEADER_WRITES.flatMap(([family, source]) =>
  (['rest', 'soap', 'grpc'] as const)
    .filter((protocol) => !pmOnGrpc(family, protocol))
    .map((protocol): EquivalenceCase => ({
      name: `${family.label} header writes on ${protocol}`,
      dialect: family.dialect,
      protocol,
      phase: 'pre',
      source,
    })),
);

const URL_AND_METHOD_WRITES: readonly EquivalenceCase[] = [
  {
    name: 'req.setUrl, req.setMethod',
    dialect: 'bruno',
    protocol: 'rest',
    phase: 'pre',
    source: `req.setUrl('https://shop.test/carts/8');
req.setMethod('PUT');
bru.setVar('url', req.getUrl());
bru.setVar('method', req.getMethod());`,
  },
];

/** Hoppscotch's `export {};` module marker, which the runner drops and the converter drops with it. */
const MODULE_MARKER_CASES: readonly EquivalenceCase[] = [
  {
    name: 'an export {} line before and after the calls',
    dialect: 'hoppscotch',
    protocol: 'rest',
    phase: 'post',
    source: `export {};
pw.env.set('a', 'x');
pw.test('status', () => { pw.expect(pw.response.status).toBe(200); });
  export {}
`,
  },
];

export const EQUIVALENCE_CASES: readonly EquivalenceCase[] = [
  ...VARIABLES,
  ...RUN_CONTROL,
  ...CRYPTO,
  ...EXPECTATIONS,
  ...RESPONSE,
  ...REQUEST_READ_CASES,
  ...REQUEST_WRITE_CASES,
  ...URL_AND_METHOD_WRITES,
  ...MODULE_MARKER_CASES,
];
