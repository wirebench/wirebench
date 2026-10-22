/**
 * The equivalence harness (spec §12): each case runs layered, is converted, type-checks against its
 * protocol's and phase's declarations with no problems, runs typed against the same snapshots, and
 * must record the same tests, values, run control and request. The documented differences (spec §6)
 * each have a case that pins the difference instead.
 */
import { afterAll, describe, expect, it, vi } from 'vitest';
import { loadProtoSet } from '../../../../src/grpc/proto/load.js';
import { grpcScriptTypes } from '../../../../src/grpc/script-types.js';
import { mcpScriptTypes } from '../../../../src/mcp/script-types.js';
import type { OpenApiOperation } from '../../../../src/rest/openapi/model.js';
import { restScriptTypes } from '../../../../src/rest/script-types.js';
import { soapScriptTypes } from '../../../../src/soap/script-types.js';
import { convertLevelScripts } from '../../../../src/script/convert/index.js';
import { MAPPINGS } from '../../../../src/script/convert/mappings.js';
import type { ConvertProtocol } from '../../../../src/script/convert/roots.js';
import type { LayeredApi, ScriptApi, ScriptOutcome, ScriptPhase } from '../../../../src/script/model.js';
import { runScript, type ScriptRunInput } from '../../../../src/script/run.js';
import { createScriptSandbox } from '../../../../src/script/sandbox/host.js';
import { apiDeclarations, secretNameType } from '../../../../src/script/types/api.js';
import { GRPC, GRPC_RESPONSE, MCP, MCP_RESPONSE, REST, REST_RESPONSE, SOAP, SOAP_RESPONSE } from '../snapshots.js';
import { typeErrors } from '../ts-check.js';
import {
  EQUIVALENCE_CASES,
  RUN_DATA,
  RUN_ITERATION,
  RUN_PROPS,
  RUN_VALUES,
  type EquivalenceCase,
} from './equivalence-cases.js';
// The composition: the entry points fall back to the registry it installs (package split spec §3.3).
import '../../../../src/protocols.js';

// A type check builds a program for its case; under coverage on a busy runner that outlasts the
// default 5 s.
vi.setConfig({ testTimeout: 30_000 });

const sandbox = createScriptSandbox();
afterAll(async () => {
  await sandbox.dispose();
});

/** A SOAP request with a header, so its header reads have something to read. */
const SOAP_REQUEST = { ...SOAP, headers: [['X-Trace', '1']] as const };

const SNAPSHOTS: Readonly<
  Record<ConvertProtocol, { request: ScriptRunInput['request']; response: NonNullable<ScriptRunInput['response']> }>
> = {
  rest: { request: REST, response: REST_RESPONSE },
  soap: { request: SOAP_REQUEST, response: SOAP_RESPONSE },
  grpc: { request: GRPC, response: GRPC_RESPONSE },
  mcp: { request: MCP, response: MCP_RESPONSE },
};

// --- the contracts the converted scripts are checked against --------------------------------------

const BODY = {
  type: 'object',
  required: ['id', 'items'],
  properties: { id: { type: 'string' }, items: { type: 'integer' } },
};
const OPERATION: OpenApiOperation = {
  method: 'post',
  path: '/carts/{id}',
  parameters: [],
  requestBody: {
    content: { 'application/json': { schema: { type: 'object', properties: { id: { type: 'string' } } } } },
  },
  responses: { default: { content: { 'application/json': { schema: BODY } } } },
};
const PROTO = loadProtoSet(
  new Map([
    [
      'shop.proto',
      `syntax = "proto3";
package shop;
message GetCart { string id = 1; }
message Cart { string id = 1; int32 items = 2; }
service Carts { rpc Get(GetCart) returns (Cart); }`,
    ],
  ]),
);
const GENERATED: Readonly<Record<ConvertProtocol, string>> = {
  rest: restScriptTypes(OPERATION),
  soap: soapScriptTypes(undefined),
  grpc: grpcScriptTypes(PROTO, 'shop.GetCart', 'shop.Cart'),
  mcp: mcpScriptTypes(undefined),
};
const declarations = (protocol: ConvertProtocol, phase: ScriptPhase): string =>
  apiDeclarations(protocol, phase) + secretNameType([]) + GENERATED[protocol];

// --- the runs ----------------------------------------------------------------------------------------

interface Run {
  readonly protocol: ConvertProtocol;
  readonly phase: ScriptPhase;
  readonly request?: ScriptRunInput['request'];
  readonly response?: NonNullable<ScriptRunInput['response']>;
}

const run = (api: ScriptApi, source: string, at: Run): Promise<ScriptOutcome> =>
  runScript({
    sandbox,
    phase: at.phase,
    api,
    source,
    filename: `Get cart.${at.phase}.${api === 'wirebench' ? 'ts' : 'js'}`,
    request: at.request ?? SNAPSHOTS[at.protocol].request,
    ...(at.phase === 'post' ? { response: at.response ?? SNAPSHOTS[at.protocol].response } : {}),
    vars: RUN_VALUES,
    props: RUN_PROPS,
    secrets: {},
    data: RUN_DATA,
    iteration: RUN_ITERATION,
    requestName: 'Get cart',
  });

/** The script converted as its level's only script, with no TODO left. */
function convert(dialect: LayeredApi, source: string, at: Run): string {
  const level = convertLevelScripts({ dialect, protocol: at.protocol, [at.phase]: source, backups: {} });
  if (!level.ok) throw new Error(`line ${String(level.line)}: ${level.message}`);
  expect(level.todos).toEqual([]);
  expect(level.mapped).toBeGreaterThan(0);
  const text = level[at.phase];
  if (text === undefined) throw new Error('no converted script');
  return text;
}

/**
 * What two runs must agree on. A test's message is not compared: the layers word their failures in
 * chai's or their own terms and the typed matchers in theirs, so only each test's name and outcome are.
 */
const observed = (outcome: ScriptOutcome) => ({
  ok: outcome.ok,
  error: outcome.ok ? undefined : outcome.error.code,
  tests: outcome.tests.map(({ name, passed }) => ({ name, passed })),
  values: outcome.values,
  control: outcome.ok ? outcome.control : undefined,
  request: outcome.ok ? outcome.request : undefined,
});

/** Runs a case both ways and returns the converted text and both outcomes. */
async function both(c: { dialect: LayeredApi; source: string } & Run) {
  const layered = await run(c.dialect, c.source, c);
  const text = convert(c.dialect, c.source, c);
  const typed = await run('wirebench', text, c);
  return { layered, text, typed };
}

/** True when `source` calls or reads `call` (`bru.setVar`, `$.response.code`) as written. */
const uses = (source: string, call: string): boolean =>
  new RegExp(`(?:^|[^\\w$.])${call.replace(/[$.]/g, (c) => `\\${c}`)}(?![\\w$])`, 'm').test(source);

describe('the cases', () => {
  it('use every row of the table on a protocol and in a phase where it maps', () => {
    const uncovered = MAPPINGS.filter((row) => Object.keys(row.to).length > 0)
      .filter(
        (row) =>
          !EQUIVALENCE_CASES.some(
            (c) =>
              row.dialects.includes(c.dialect) &&
              (row.phase === undefined || row.phase === c.phase) &&
              row.to[c.protocol] !== undefined &&
              row.calls.some((call) => uses(c.source, call)),
          ),
      )
      .map((row) => row.calls[0]);
    expect(uncovered).toEqual([]);
  });
});

describe('a converted script behaves like its layered original', () => {
  it.each(EQUIVALENCE_CASES.map((c) => ({ ...c, label: `${c.dialect} ${c.phase} on ${c.protocol}: ${c.name}` })))(
    '$label',
    async (c: EquivalenceCase) => {
      const { layered, text, typed } = await both(c);
      expect(typeErrors(declarations(c.protocol, c.phase), text), text).toEqual([]);
      expect(layered).toMatchObject({ ok: true });
      expect(observed(typed), text).toEqual(observed(layered));
      // The inputs are chosen so: a test named "… fails" fails, every other one passes.
      for (const t of layered.tests)
        expect({ name: t.name, passed: t.passed }).toEqual({ name: t.name, passed: !t.name.endsWith('fails') });
    },
  );
});

// --- the documented differences (spec §6) --------------------------------------------------------------

describe('the documented differences', () => {
  it('a body that is not JSON: res.body reads the text, response.json() throws', async () => {
    const response = { ...REST_RESPONSE, headers: [['Content-Type', 'text/plain']] as const, text: 'plain' };
    const { layered, text, typed } = await both({
      dialect: 'bruno',
      protocol: 'rest',
      phase: 'post',
      response,
      source: `bru.setVar('body', res.body);`,
    });
    expect(text).toContain("vars.set('body', response.json() as any);");
    expect(layered).toMatchObject({ ok: true, values: [{ name: 'body', value: 'plain' }] });
    expect(typed).toMatchObject({ ok: false, error: { code: 'script-error' }, values: [] });
  });

  it("a repeated header: res.getHeader joins the values with ', ', headers.get gives the first", async () => {
    const response = {
      ...REST_RESPONSE,
      headers: [
        ['Set-Cookie', 'a=1'],
        ['Set-Cookie', 'b=2'],
      ] as const,
    };
    const { layered, text, typed } = await both({
      dialect: 'bruno',
      protocol: 'rest',
      phase: 'post',
      response,
      source: `test('cookie', () => { expect(res.getHeader('set-cookie')).to.equal('a=1, b=2'); });`,
    });
    expect(text).toContain("expect(response.headers.get('set-cookie')).toBe('a=1, b=2')");
    expect(layered.tests).toEqual([{ name: 'cookie', passed: true }]);
    expect(typed.tests).toMatchObject([{ name: 'cookie', passed: false }]);
  });

  it('deep equality: eql fails on reordered keys layered, toEqual passes', async () => {
    const { layered, text, typed } = await both({
      dialect: 'postman',
      protocol: 'rest',
      phase: 'post',
      source: `pm.test('order', () => { pm.expect({ a: 1, b: 2 }).to.eql({ b: 2, a: 1 }); });`,
    });
    expect(typeErrors(declarations('rest', 'post'), text)).toEqual([]);
    expect(layered.tests).toMatchObject([{ name: 'order', passed: false }]);
    expect(typed.tests).toEqual([{ name: 'order', passed: true }]);
  });

  it('pm.request on gRPC: the layer throws a TypeError, the converted script reads the metadata', async () => {
    for (const [dialect, root] of [
      ['postman', 'pm'],
      ['insomnia', 'insomnia'],
      ['hoppscotch', 'pm'],
    ] as const) {
      const { layered, text, typed } = await both({
        dialect,
        protocol: 'grpc',
        phase: 'pre',
        source: `${root}.request.headers.upsert({ key: 'x-tenant', value: 'acme' });
${root}.environment.set('trace', ${root}.request.headers.get('x-trace'));`,
      });
      expect(text).toContain("request.metadata.set('x-tenant', 'acme');");
      expect(layered).toMatchObject({ ok: false, error: { code: 'script-error', message: /TypeError/ } });
      expect(typed).toMatchObject({
        ok: true,
        values: [{ name: 'trace', value: '1' }],
        request: {
          metadata: [
            ['x-trace', '1'],
            ['x-tenant', 'acme'],
          ],
        },
      });
    }
  });

  it("toBeLevel2xx on the string '200': the layer fails, the converted arithmetic passes", async () => {
    const { layered, text, typed } = await both({
      dialect: 'hoppscotch',
      protocol: 'rest',
      phase: 'post',
      source: `pw.test('level', () => { pw.expect('200').toBeLevel2xx(); });`,
    });
    expect(text).toContain("expect(Math.floor('200' / 100)).toBe(2)");
    // The type check names the string: arithmetic on it is what changed the outcome.
    expect(typeErrors(declarations('rest', 'post'), text)).not.toEqual([]);
    expect(layered.tests).toMatchObject([{ name: 'level', passed: false }]);
    expect(typed.tests).toEqual([{ name: 'level', passed: true }]);
  });

  it('tc.test with an async callback: test(n, f), so both runs settle the promise alike', async () => {
    const { layered, text, typed } = await both({
      dialect: 'thunder-client',
      protocol: 'rest',
      phase: 'post',
      source: `tc.test('later', async () => { await 0; expect(tc.response.status).to.equal(500); });`,
    });
    expect(text).toContain("test('later', async () => { await 0; expect(response.status).toBe(500); });");
    expect(typeErrors(declarations('rest', 'post'), text)).toEqual([]);
    // Checking the returned promise (`expect((f)()).not.toBe(false)`) would pass whatever it settles
    // to; handing the callback to test makes the typed run settle it as the layer's test does.
    expect(observed(typed)).toEqual(observed(layered));
  });

  it('tc.test with a boolean variable: the layer passes on true, the converted call fails loudly', async () => {
    const { layered, text, typed } = await both({
      dialect: 'thunder-client',
      protocol: 'rest',
      phase: 'post',
      source: `const ok = tc.response.status === 200;
tc.test('flag', ok);`,
    });
    expect(text).toContain("test('flag', () => expect<unknown>((ok)()).not.toBe(false))");
    expect(typeErrors(declarations('rest', 'post'), text)).not.toEqual([]);
    expect(layered.tests).toEqual([{ name: 'flag', passed: true }]);
    expect(typed.tests).toMatchObject([{ name: 'flag', passed: false, message: /not a function/ }]);
  });
});
