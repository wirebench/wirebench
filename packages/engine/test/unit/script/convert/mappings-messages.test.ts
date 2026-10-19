/**
 * The mapping table's response and request rows (spec §6.5, §6.6): each call under each dialect and
 * protocol, every `—` cell as a TODO, the response rows in a pre-request script, the request setters
 * in a post-response script, and the argument shapes the rows insist on.
 */
import ts from 'typescript';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { GrpcRequestSnapshot, GrpcResponseSnapshot } from '../../../../src/grpc/scripting.js';
import { restScriptTypes } from '../../../../src/rest/script-types.js';
import type { RestRequestSnapshot, RestResponseSnapshot } from '../../../../src/rest/scripting.js';
import { sentRequestReason } from '../../../../src/script/api/prelude.js';
import { TC_NO_RESPONSE_YET, THUNDER_CLIENT_LAYER } from '../../../../src/script/api/thunder-client.js';
import { convertScript } from '../../../../src/script/convert/index.js';
import type { ConvertProtocol } from '../../../../src/script/convert/roots.js';
import type { LayeredApi, ScriptPhase } from '../../../../src/script/model.js';
import { runScript, type ScriptRunInput } from '../../../../src/script/run.js';
import { createScriptSandbox } from '../../../../src/script/sandbox/host.js';
import { apiDeclarations, secretNameType } from '../../../../src/script/types/api.js';
import { typeErrors } from '../ts-check.js';

// A type check builds a program for its case; under coverage on a busy runner that outlasts the
// default 5 s.
vi.setConfig({ testTimeout: 30_000 });

const PROTOCOLS: readonly ConvertProtocol[] = ['rest', 'soap', 'grpc', 'mcp'];
const NOT_CONVERTED = 'not converted yet';

/** The converted script without its header line. */
function converted(dialect: LayeredApi, text: string, protocol: ConvertProtocol = 'rest', phase: ScriptPhase = 'post') {
  const result = convertScript({ dialect, protocol, phase, text });
  if (!result.ok) throw new Error(result.message);
  return { ...result, body: result.text.slice(result.text.indexOf('\n') + 1) };
}

/** The call a TODO names for `snippet`: its dotted chain, without the arguments. */
const callOf = (snippet: string): string => /^[\w$]+(?:\.[\w$]+)*/.exec(snippet)?.[0] ?? snippet;

/** `chain` under each `pm`-shaped root: Postman's and Hoppscotch's `pm`, Insomnia's `insomnia` and `$`. */
const pmShaped = (chain: string): (readonly [LayeredApi, string])[] => [
  ['postman', `pm.${chain}`],
  ['insomnia', `insomnia.${chain}`],
  ['insomnia', `$.${chain}`],
  ['hoppscotch', `pm.${chain}`],
];

/**
 * One row of the tables: the snippets that call it, the statement each is written in (`CALL` for the
 * snippet, `OUT` for the template) and the template per protocol; a protocol it lacks is a `—`.
 */
interface Row {
  readonly name: string;
  readonly calls: readonly (readonly [LayeredApi, string])[];
  readonly statement: string;
  readonly to: Partial<Record<ConvertProtocol, string>>;
}

/** Each row converts on the protocols it names and is a TODO on the others. */
function checkRow(row: Row, phase: ScriptPhase): void {
  describe(row.name, () => {
    for (const protocol of PROTOCOLS) {
      const out = row.to[protocol];
      it.each(row.calls.map(([dialect, call]) => ({ dialect, call })))(
        `$call ($dialect) on ${protocol}${out === undefined ? ' is a TODO' : ''}`,
        ({ dialect, call }) => {
          const from = `${row.statement.replace('CALL', call)}\n`;
          const result = converted(dialect, from, protocol, phase);
          if (out === undefined) {
            expect(result.body).toBe(`// TODO(convert): ${callOf(call)} — ${NOT_CONVERTED}\n// ${from}`);
            expect(result.todos).toEqual([
              { phase, line: 2, call: callOf(call), kind: 'not-mapped', reason: NOT_CONVERTED },
            ]);
            expect(result.mapped).toBe(0);
          } else {
            expect(result.body).toBe(`${row.statement.replace('CALL', out)}\n`);
            expect(result.todos).toEqual([]);
            expect(result.mapped).toBe(1);
          }
        },
      );
    }
  });
}

// --- §6.5 the response --------------------------------------------------------------------------

const RESPONSE_ROWS: readonly Row[] = [
  {
    name: 'status',
    calls: [
      ...pmShaped('response.code'),
      ['bruno', 'res.status'],
      ['bruno', 'res.getStatus()'],
      ['hoppscotch', 'pw.response.status'],
      ['hoppscotch', 'hopp.response.statusCode'],
      ['thunder-client', 'tc.response.status'],
    ],
    statement: 'const status = CALL;',
    to: { rest: 'response.status', soap: 'response.status', grpc: 'response.status.code' },
  },
  {
    name: 'JSON body',
    calls: [
      ...pmShaped('response.json()'),
      ['hoppscotch', 'hopp.response.body.asJSON()'],
      ['thunder-client', 'tc.response.json'],
    ],
    statement: 'const body = CALL;',
    to: { rest: 'response.json() as any', grpc: 'response.message' },
  },
  {
    name: 'body',
    calls: [
      ['bruno', 'res.body'],
      ['bruno', 'res.getBody()'],
      ['hoppscotch', 'pw.response.body'],
    ],
    statement: 'const body = CALL;',
    to: { rest: 'response.json() as any', soap: 'response.text', grpc: 'response.message' },
  },
  {
    name: 'text',
    calls: [
      ...pmShaped('response.text()'),
      ['hoppscotch', 'hopp.response.body.asText()'],
      ['thunder-client', 'tc.response.text'],
    ],
    statement: 'const text = CALL;',
    to: { rest: 'response.text', soap: 'response.text', grpc: 'JSON.stringify(response.message)' },
  },
  {
    name: 'header',
    calls: [
      ...pmShaped("response.headers.get('X-Id')"),
      ['bruno', "res.getHeader('X-Id')"],
      ['thunder-client', "tc.response.getHeader('X-Id')"],
    ],
    statement: 'const id = CALL;',
    to: {
      rest: "response.headers.get('X-Id')",
      soap: "response.headers.get('X-Id')",
      grpc: "response.metadata.get('X-Id')",
    },
  },
  {
    name: 'duration',
    calls: [
      ...pmShaped('response.responseTime'),
      ['bruno', 'res.responseTime'],
      ['bruno', 'res.getResponseTime()'],
      ['hoppscotch', 'hopp.response.responseTime'],
      ['thunder-client', 'tc.response.time'],
    ],
    statement: 'const ms = CALL;',
    to: {
      rest: 'response.durationMs',
      soap: 'response.durationMs',
      grpc: 'response.durationMs',
      mcp: 'response.durationMs',
    },
  },
  {
    name: 'status assertion',
    calls: pmShaped('response.to.have.status(201)'),
    statement: 'CALL;',
    to: {
      rest: 'expect(response.status).toBe(201)',
      soap: 'expect(response.status).toBe(201)',
      grpc: 'expect(response.status.code).toBe(201)',
    },
  },
];

describe('§6.5 response rows in a post-response script', () => {
  for (const row of RESPONSE_ROWS) checkRow(row, 'post');
});

describe('§6.5 response rows in a pre-request script are TODOs', () => {
  for (const row of RESPONSE_ROWS) {
    it.each(row.calls.map(([dialect, call]) => ({ dialect, call })))(
      `${row.name}: $call ($dialect)`,
      ({ dialect, call }) => {
        // Only Thunder Client's layer refuses its response before the request, and says why.
        const thunder = call.startsWith('tc.');
        const reason = thunder ? TC_NO_RESPONSE_YET : NOT_CONVERTED;
        for (const protocol of PROTOCOLS) {
          const from = `${row.statement.replace('CALL', call)}\n`;
          const result = converted(dialect, from, protocol, 'pre');
          expect(result.body).toBe(`// TODO(convert): ${callOf(call)} — ${reason}\n// ${from}`);
          expect(result.todos).toEqual([
            { phase: 'pre', line: 2, call: callOf(call), kind: thunder ? 'unsupported' : 'not-mapped', reason },
          ]);
        }
      },
    );
  }

  it("carries the reason Thunder Client's layer throws", () => {
    expect(THUNDER_CLIENT_LAYER).toContain(
      "unsupported('tc.response in a pre-request script', 'there is no response before the request is sent')",
    );
    expect(TC_NO_RESPONSE_YET).toBe('there is no response before the request is sent');
    expect(converted('thunder-client', 'const id = tc.response.json.id;\n', 'rest', 'pre').todos).toEqual([
      { phase: 'pre', line: 2, call: 'tc.response.json.id', kind: 'unsupported', reason: TC_NO_RESPONSE_YET },
    ]);
  });
});

describe('§6.5 shapes', () => {
  it('reads a property chain after a response property through the template', () => {
    expect(converted('bruno', 'const id = res.body.id;\n').body).toBe('const id = (response.json() as any).id;\n');
    expect(converted('bruno', 'const id = res.body?.user.id;\n', 'grpc').body).toBe(
      'const id = response.message?.user.id;\n',
    );
    expect(converted('thunder-client', 'const n = tc.response.json.items.length;\n').body).toBe(
      'const n = (response.json() as any).items.length;\n',
    );
    expect(converted('postman', 'const ok = pm.response.code.toString();\n', 'grpc').body).toBe(
      'const ok = response.status.code.toString();\n',
    );
  });

  it('keeps a chain on a called response through the template', () => {
    expect(converted('postman', "pm.environment.set('id', pm.response.json().id);\n").body).toBe(
      "vars.set('id', (response.json() as any).id);\n",
    );
  });

  it('converts a header name read from a variable', () => {
    expect(converted('bruno', "const id = res.getHeader(fallback ?? bru.getVar('h'));\n").body).toBe(
      "const id = response.headers.get(fallback ?? (vars.get('h') ?? props.get('h')));\n",
    );
  });

  it('leaves a chain read past a response property as a TODO where the property is', () => {
    expect(converted('bruno', 'const id = res.body.id;\n', 'rest', 'pre').todos.map(({ call }) => call)).toEqual([
      'res.body.id',
    ]);
    expect(converted('bruno', 'const id = res.body.id;\n', 'mcp').todos.map(({ call }) => call)).toEqual([
      'res.body.id',
    ]);
  });

  it('leaves a written response property as a TODO', () => {
    expect(converted('bruno', 'res.body.id = 2;\n').todos.map(({ call }) => call)).toEqual(['res.body.id']);
    expect(converted('bruno', 'res.status = 2;\n').todos.map(({ call }) => call)).toEqual(['res.status']);
  });

  it('leaves a write through an element or a deeper property as a TODO, since json() reads afresh', () => {
    for (const [statement, call] of [
      ["res.body['id'] = 2;", 'res.body'],
      ['res.body.items[0] = 1;', 'res.body.items'],
      ['res.body.items[0].name += "x";', 'res.body.items'],
      ['(res.body).count++;', 'res.body'],
      ["delete res.body['id'];", 'res.body'],
      ['res.body!.id = 2;', 'res.body'],
      ['[res.body.a, res.body.b] = pair;', 'res.body.a'],
      ['({ a: res.body.a } = pair);', 'res.body.a'],
      ['for (res.body.x of list) log(1);', 'res.body.x'],
      ['for (tc.response.json.k in obj) log(1);', 'tc.response.json.k'],
    ] as const) {
      const dialect: LayeredApi = call.startsWith('tc.') ? 'thunder-client' : 'bruno';
      const result = converted(dialect, `${statement}\n`, 'rest', 'post');
      expect(result.mapped, statement).toBe(0);
      expect(result.todos.map(({ call: c }) => c)[0], statement).toBe(call);
    }
  });

  it('still converts a read beside a write', () => {
    expect(converted('bruno', 'x[res.body.id] = 1;\n').body).toBe('x[(response.json() as any).id] = 1;\n');
    expect(converted('bruno', 'const [a] = [res.body.a];\n').body).toBe('const [a] = [(response.json() as any).a];\n');
    expect(converted('bruno', 'total = res.body.items[0];\n').body).toBe(
      'total = (response.json() as any).items[0];\n',
    );
    expect(converted('bruno', 'for (const x of res.body.items) log(x);\n').body).toBe(
      'for (const x of (response.json() as any).items) log(x);\n',
    );
  });

  it('asserts a status as the expression body of an arrow', () => {
    expect(converted('postman', "pm.test('ok', () => pm.response.to.have.status(200));\n").body).toBe(
      "test('ok', () => expect(response.status).toBe(200));\n",
    );
    expect(
      converted('insomnia', "insomnia.test('ok', () => insomnia.response.to.have.status(200));\n", 'grpc').body,
    ).toBe("test('ok', () => expect(response.status.code).toBe(200));\n");
  });

  it('keeps a setter a statement: an arrow body is a TODO there', () => {
    const result = converted('bruno', 'const go = () => req.setUrl(u);\n', 'rest', 'pre');
    expect(result.body).toBe(`// TODO(convert): req.setUrl — ${NOT_CONVERTED}\n// const go = () => req.setUrl(u);\n`);
  });

  it('asserts a status only for a number literal, as a statement of its own', () => {
    expect(converted('postman', "pm.test('ok', () => {\n  pm.response.to.have.status(200);\n});\n").body).toBe(
      "test('ok', () => {\n  expect(response.status).toBe(200);\n});\n",
    );
    for (const statement of [
      'pm.response.to.have.status(code);',
      "pm.response.to.have.status('Created');",
      'pm.response.to.have.status();',
      'pm.response.to.have.status(200, 201);',
      'const done = pm.response.to.have.status(200);',
      'ok && pm.response.to.have.status(200);',
    ]) {
      const result = converted('postman', `${statement}\n`);
      expect(result.body).toBe(`// TODO(convert): pm.response.to.have.status — ${NOT_CONVERTED}\n// ${statement}\n`);
    }
  });
});

describe('the crafted fixtures type-check after converting, on a request with no contract', () => {
  const untyped = (phase: ScriptPhase): string =>
    apiDeclarations('rest', phase) + secretNameType([]) + restScriptTypes(undefined);

  it('reads the JSON body untyped, as the layers do', () => {
    for (const [dialect, text] of [
      ['bruno', 'bru.setVar("userId", res.body.id);\n'],
      ['postman', 'pm.environment.set("bookId", pm.response.json().id);\n'],
      ['thunder-client', 'var json = tc.response.json;\ntc.setVar("firstName", json.data.product.name);\n'],
      ['hoppscotch', 'const n = pw.response.body.items.length;\n'],
    ] as const) {
      const result = converted(dialect, text);
      expect(result.todos, text).toEqual([]);
      expect(typeErrors(untyped('post'), result.text), text).toEqual([]);
    }
    expect(converted('thunder-client', 'var json = tc.response.json;\n').body).toBe(
      'var json = response.json() as any;\n',
    );
  });

  it('keeps a script written without semicolons from joining a statement that now opens with (', () => {
    const parses = (text: string): readonly unknown[] =>
      (
        ts.createSourceFile('s.ts', text, ts.ScriptTarget.Latest, true) as ts.SourceFile & {
          parseDiagnostics?: readonly unknown[];
        }
      ).parseDiagnostics ?? [];
    for (const [dialect, from, to] of [
      [
        'bruno',
        'const a = 1\nres.body.items.forEach(log)\n',
        'const a = 1\n;(response.json() as any).items.forEach(log)\n',
      ],
      [
        'postman',
        "console.log('x')\npm.response.json().items.forEach(log)\n",
        "console.log('x')\n;(response.json() as any).items.forEach(log)\n",
      ],
      // An object literal's `}` still joins the next line.
      ['bruno', 'const o = {}\nres.body.items.pop()\n', 'const o = {}\n;(response.json() as any).items.pop()\n'],
      // A `;`, a block's `}` or the start of the file already keeps them apart.
      ['bruno', 'const a = 1;\nres.body.items.pop()\n', 'const a = 1;\n(response.json() as any).items.pop()\n'],
      ['bruno', 'if (flag) {}\nres.body.items.pop()\n', 'if (flag) {}\n(response.json() as any).items.pop()\n'],
      ['bruno', 'res.body.items.pop()\n', '(response.json() as any).items.pop()\n'],
      ['bruno', 'if (flag) {\n  res.body.items.pop()\n}\n', 'if (flag) {\n  (response.json() as any).items.pop()\n}\n'],
      // The body of an `if` without braces is not a statement of a list.
      ['bruno', 'if (flag)\n  res.body.items.pop()\n', 'if (flag)\n  (response.json() as any).items.pop()\n'],
    ] as const) {
      const result = converted(dialect, from);
      expect(result.body, from).toBe(to);
      expect(parses(result.text), from).toEqual([]);
      expect(
        typeErrors(
          untyped('post').replace(/^/, 'declare const flag: boolean;\ndeclare function log(v: unknown): void;\n'),
          result.text,
        ),
        from,
      ).toEqual([]);
    }
  });

  it('passes a header value that is not a string literal through String(), as every layer does', () => {
    const result = converted(
      'postman',
      "pm.request.headers.add({ key: 'X-Trace', value: pm.variables.get('traceId') });\n" +
        "pm.request.headers.add({ key: 'X-Signed', value: 'yes' });\n" +
        "pm.request.headers.upsert({ key: `X-${'n'}`, value: 2 });\n",
      'rest',
      'pre',
    );
    expect(result.body).toBe(
      "request.headers.add('X-Trace', String((vars.get('traceId') ?? props.get('traceId'))));\n" +
        "request.headers.add('X-Signed', 'yes');\n" +
        "request.headers.set(String(`X-${'n'}`), String(2));\n",
    );
    expect(typeErrors(untyped('pre'), result.text)).toEqual([]);
  });
});

describe('§6.5 not mapped', () => {
  it.each([
    ['postman', 'const v = pm.response.status;'],
    ['postman', 'const v = pm.response.responseSize;'],
    ['bruno', 'const v = res.getSize();'],
    ['thunder-client', 'const v = tc.response.size;'],
    ['thunder-client', 'const v = tc.response.contentType;'],
    ['postman', 'pm.response.to.be.ok;'],
    ['postman', "pm.response.to.have.header('X-Id');"],
    ['postman', 'pm.response.to.have.jsonBody();'],
    ['postman', "pm.response.to.have.body('x');"],
  ] as const)('%s: %s', (dialect, statement) => {
    for (const protocol of PROTOCOLS) {
      const result = converted(dialect, `${statement}\n`, protocol);
      expect(result.body).toBe(
        `// TODO(convert): ${callOf(statement.replace(/^const v = /, ''))} — ${NOT_CONVERTED}\n// ${statement}\n`,
      );
      expect(result.todos.map(({ kind }) => kind)).toEqual(['not-mapped']);
    }
  });
});

// --- §6.6 the request ---------------------------------------------------------------------------

const SETTER_ROWS: readonly (Row & {
  readonly what: Partial<Record<ConvertProtocol, Parameters<typeof sentRequestReason>[0]>>;
})[] = [
  {
    name: 'headers.add',
    calls: pmShaped("request.headers.add({ key: 'X-Id', value: id })"),
    statement: 'CALL;',
    to: {
      rest: "request.headers.add('X-Id', String(id))",
      soap: "request.headers.add('X-Id', String(id))",
      grpc: "request.metadata.add('X-Id', String(id))",
    },
    what: { rest: 'header', soap: 'header', grpc: 'metadata' },
  },
  {
    name: 'header set',
    calls: [
      ...pmShaped("request.headers.upsert({ key: 'X-Id', value: id })"),
      ['bruno', "req.setHeader('X-Id', id)"],
      ['hoppscotch', "hopp.request.setHeader('X-Id', id)"],
    ],
    statement: 'CALL;',
    to: {
      rest: "request.headers.set('X-Id', String(id))",
      soap: "request.headers.set('X-Id', String(id))",
      grpc: "request.metadata.set('X-Id', String(id))",
    },
    what: { rest: 'header', soap: 'header', grpc: 'metadata' },
  },
  {
    name: 'header delete',
    calls: [
      ...pmShaped("request.headers.remove('X-Id')"),
      ['bruno', "req.deleteHeader('X-Id')"],
      ['hoppscotch', "hopp.request.removeHeader('X-Id')"],
    ],
    statement: 'CALL;',
    to: {
      rest: "request.headers.delete('X-Id')",
      soap: "request.headers.delete('X-Id')",
      grpc: "request.metadata.delete('X-Id')",
    },
    what: { rest: 'header', soap: 'header', grpc: 'metadata' },
  },
  {
    name: 'setUrl',
    calls: [['bruno', 'req.setUrl(u)']],
    statement: 'CALL;',
    to: { rest: 'request.url = u' },
    what: { rest: 'URL' },
  },
  {
    name: 'setMethod',
    calls: [['bruno', 'req.setMethod(m)']],
    statement: 'CALL;',
    to: { rest: 'request.method = m' },
    what: { rest: 'method' },
  },
];

const READ_ROWS: readonly Row[] = [
  {
    name: 'header read',
    calls: [...pmShaped("request.headers.get('X-Id')"), ['bruno', "req.getHeader('X-Id')"]],
    statement: 'const id = CALL;',
    to: {
      rest: "request.headers.get('X-Id')",
      soap: "request.headers.get('X-Id')",
      grpc: "request.metadata.get('X-Id')",
    },
  },
  {
    name: 'URL',
    calls: [['bruno', 'req.getUrl()']],
    statement: 'const url = CALL;',
    to: { rest: 'request.url', soap: 'request.endpoint', grpc: 'request.target', mcp: 'request.url' },
  },
  // The pm-shaped layers read a SOAP request's url, which it has not: they give 'undefined'.
  {
    name: 'URL, pm-shaped',
    calls: pmShaped('request.url.toString()'),
    statement: 'const url = CALL;',
    to: { rest: 'request.url', grpc: 'request.target', mcp: 'request.url' },
  },
  {
    name: 'method',
    calls: [['bruno', 'req.getMethod()'], ...pmShaped('request.method')],
    statement: 'const method = CALL;',
    to: { rest: 'request.method', grpc: 'request.method', mcp: 'request.method' },
  },
];

describe('§6.6 request setters in a pre-request script', () => {
  for (const row of SETTER_ROWS) checkRow(row, 'pre');
});

describe('§6.6 request reads in both phases', () => {
  for (const row of READ_ROWS) {
    checkRow(row, 'pre');
    checkRow(row, 'post');
  }
});

describe("§6.6 a setter in a post-response script is a TODO with the layer's reason", () => {
  for (const row of SETTER_ROWS) {
    for (const protocol of PROTOCOLS) {
      const what = row.what[protocol];
      it.each(row.calls.map(([dialect, call]) => ({ dialect, call })))(
        `${row.name}: $call ($dialect) on ${protocol}`,
        ({ dialect, call }) => {
          const from = `${call};\n`;
          const result = converted(dialect, from, protocol, 'post');
          const name = callOf(call);
          if (what === undefined) {
            expect(result.body).toBe(`// TODO(convert): ${name} — ${NOT_CONVERTED}\n// ${from}`);
            expect(result.todos).toEqual([
              { phase: 'post', line: 2, call: name, kind: 'not-mapped', reason: NOT_CONVERTED },
            ]);
          } else {
            const reason = sentRequestReason(what);
            expect(result.body).toBe(`// TODO(convert): ${name} — ${reason}\n// ${from}`);
            expect(result.todos).toEqual([{ phase: 'post', line: 2, call: name, kind: 'unsupported', reason }]);
          }
          expect(result.mapped).toBe(0);
        },
      );
    }
  }
});

describe('§6.6 shapes', () => {
  it('writes the URL or method only as a statement of its own', () => {
    for (const statement of ['const r = req.setUrl(u);', 'ok && req.setUrl(u);', 'log(req.setMethod(m));']) {
      const result = converted('bruno', `${statement}\n`, 'rest', 'pre');
      expect(result.body).toBe(
        `// TODO(convert): ${/req\.\w+/.exec(statement)?.[0] ?? ''} — ${NOT_CONVERTED}\n// ${statement}\n`,
      );
    }
    expect(converted('bruno', "if (v2) req.setUrl(bru.getVar('url'));\n", 'rest', 'pre').body).toBe(
      "if (v2) request.url = (vars.get('url') ?? props.get('url'));\n",
    );
  });

  it('adds or upserts a header only from an object literal of exactly key and value', () => {
    for (const statement of [
      'pm.request.headers.add(header);',
      "pm.request.headers.add({ key: 'X-Id' });",
      "pm.request.headers.add({ key: 'X-Id', value: id, disabled: true });",
      "pm.request.headers.add({ ...base, key: 'X-Id', value: id });",
      'pm.request.headers.upsert(header);',
      "pm.request.headers.add('X-Id', id);",
    ]) {
      const result = converted('postman', `${statement}\n`, 'rest', 'pre');
      expect(result.body).toBe(`// TODO(convert): ${callOf(statement)} — ${NOT_CONVERTED}\n// ${statement}\n`);
    }
    expect(
      converted('postman', "pm.request.headers.add({ 'value': v, key: pm.environment.get('k') });\n", 'grpc', 'pre')
        .body,
    ).toBe("request.metadata.add(String((vars.get('k') ?? props.get('k'))), String(v));\n");
  });

  it('takes key and value written shorthand', () => {
    expect(converted('postman', 'pm.request.headers.upsert({ key, value });\n', 'rest', 'pre').body).toBe(
      'request.headers.set(String(key), String(value));\n',
    );
  });

  it('removes a header only by a string', () => {
    for (const statement of ['pm.request.headers.remove(name);', "pm.request.headers.remove({ key: 'X-Id' });"]) {
      const result = converted('postman', `${statement}\n`, 'rest', 'pre');
      expect(result.body).toBe(`// TODO(convert): pm.request.headers.remove — ${NOT_CONVERTED}\n// ${statement}\n`);
    }
    expect(converted('bruno', 'req.deleteHeader(name);\n', 'rest', 'pre').body).toBe('request.headers.delete(name);\n');
  });

  it('leaves a written request method as a TODO', () => {
    expect(converted('postman', "pm.request.method = 'PUT';\n", 'rest', 'pre').todos.map(({ call }) => call)).toEqual([
      'pm.request.method',
    ]);
  });
});

describe('§6.6 not mapped', () => {
  it.each([
    ['bruno', 'const v = req.getBody();'],
    ['bruno', 'req.setBody(b);'],
    ['postman', 'const v = pm.request.body.raw;'],
    ['hoppscotch', 'hopp.request.setBody(b);'],
    ['thunder-client', 'tc.request.setBody(b);'],
    ['thunder-client', "tc.request.setHeader('a', 'b');"],
    ['hoppscotch', "hopp.request.setUrl('u');"],
    ['postman', 'const v = pm.request.url.getHost();'],
    ['postman', 'const v = pm.request.url.getPath();'],
    ['postman', "pm.request.url.query.add({ key: 'a', value: 'b' });"],
  ] as const)('%s: %s', (dialect, statement) => {
    for (const protocol of PROTOCOLS) {
      const result = converted(dialect, `${statement}\n`, protocol, 'pre');
      expect(result.body).toBe(
        `// TODO(convert): ${callOf(statement.replace(/^const v = /, ''))} — ${NOT_CONVERTED}\n// ${statement}\n`,
      );
      expect(result.todos.map(({ kind }) => kind)).toEqual(['not-mapped']);
    }
  });
});

// --- the reasons are the layers' own --------------------------------------------------------------

/**
 * `pm.request` on a gRPC call fails with a plain TypeError in every phase (layers spec §14), so the
 * gRPC reason is pinned through the layers that reach the metadata.
 */
describe('a setter in a post-response script throws the reason its TODO gives', () => {
  const sandbox = createScriptSandbox();
  afterAll(async () => {
    await sandbox.dispose();
  });

  const REST: RestRequestSnapshot = {
    protocol: 'rest',
    method: 'GET',
    url: 'https://shop.test/a',
    headers: [],
    body: { kind: 'none' },
  };
  const REST_RESPONSE: RestResponseSnapshot = {
    protocol: 'rest',
    status: 200,
    statusText: 'OK',
    headers: [],
    text: '',
    durationMs: 1,
  };
  const GRPC: GrpcRequestSnapshot = {
    protocol: 'grpc',
    target: 'grpc.test:443',
    method: 'shop.Carts/Get',
    metadata: [],
    message: {},
  };
  const GRPC_RESPONSE: GrpcResponseSnapshot = {
    protocol: 'grpc',
    status: { code: 0, name: 'OK', message: '' },
    metadata: [],
    trailers: [],
    message: {},
    durationMs: 1,
  };

  const messageOf = async (
    api: LayeredApi,
    source: string,
    request: ScriptRunInput['request'],
    response: NonNullable<ScriptRunInput['response']>,
  ): Promise<string | undefined> => {
    const outcome = await runScript({
      sandbox,
      phase: 'post',
      api,
      source,
      filename: 'A.post.js',
      request,
      response,
      vars: {},
      props: {},
      secrets: {},
      requestName: 'A',
    });
    return outcome.ok ? undefined : outcome.error.message;
  };

  it.each([
    ['postman', "pm.request.headers.add({ key: 'a', value: 'b' });", 'header'],
    ['bruno', "req.setHeader('a', 'b');", 'header'],
    ['hoppscotch', "hopp.request.removeHeader('a');", 'header'],
    ['bruno', "req.setUrl('https://shop.test/b');", 'URL'],
    ['bruno', "req.setMethod('PUT');", 'method'],
  ] as const)('REST: %s %s', async (api, source, what) => {
    expect(await messageOf(api, source, REST, REST_RESPONSE)).toContain(sentRequestReason(what));
  });

  it.each([
    ['bruno', "req.setHeader('a', 'b');"],
    ['hoppscotch', "hopp.request.setHeader('a', 'b');"],
  ] as const)('gRPC: %s %s', async (api, source) => {
    expect(await messageOf(api, source, GRPC, GRPC_RESPONSE)).toContain(sentRequestReason('metadata'));
  });
});
