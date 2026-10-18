/**
 * The mapping table's variable, run-control and iteration rows (spec §6.3, §6.7): each call under
 * each dialect and protocol, the TODO in the phase a row does not cover, and the calls left as TODOs.
 */
import { describe, expect, it } from 'vitest';
import { PART_VARIABLES, UNSUPPORTED_WHY } from '../../../../src/script/api/layer-parts.js';
import { SKIP_REQUEST_PRE_ONLY } from '../../../../src/script/api/prelude.js';
import { convertLevelScripts, convertScript } from '../../../../src/script/convert/index.js';
import type { ConvertProtocol } from '../../../../src/script/convert/roots.js';
import type { LayeredApi, ScriptPhase } from '../../../../src/script/model.js';

const PROTOCOLS: readonly ConvertProtocol[] = ['rest', 'soap', 'grpc', 'mcp'];

/** The converted script without its header line. */
function converted(dialect: LayeredApi, text: string, protocol: ConvertProtocol = 'rest', phase: ScriptPhase = 'pre') {
  const result = convertScript({ dialect, protocol, phase, text });
  if (!result.ok) throw new Error(result.message);
  return { ...result, body: result.text.slice(result.text.indexOf('\n') + 1) };
}

/** The `pm`-shaped roots: Postman's and Hoppscotch's `pm`, Insomnia's `insomnia` and `$`. */
const PM_ROOTS: readonly (readonly [LayeredApi, string])[] = [
  ['postman', 'pm'],
  ['insomnia', 'insomnia'],
  ['insomnia', '$'],
  ['hoppscotch', 'pm'],
];
const SCOPES = ['environment', 'collectionVariables', 'globals', 'variables'];
const INSOMNIA_SCOPES = ['baseEnvironment', 'parentFolders'];

/** `<root>.<scope>.<method>` for every dialect that runs it (Hoppscotch's pm has no collectionVariables). */
function scoped(method: string): (readonly [LayeredApi, string])[] {
  return [
    ...PM_ROOTS.flatMap(([dialect, root]) =>
      SCOPES.filter((scope) => !(dialect === 'hoppscotch' && scope === 'collectionVariables')).map(
        (scope) => [dialect, `${root}.${scope}.${method}`] as const,
      ),
    ),
    ...['insomnia', '$'].flatMap((root) =>
      INSOMNIA_SCOPES.map((scope) => ['insomnia', `${root}.${scope}.${method}`] as const),
    ),
  ];
}
const pmShaped = (chain: string, dialects: readonly LayeredApi[] = ['postman', 'insomnia', 'hoppscotch']) =>
  PM_ROOTS.filter(([dialect]) => dialects.includes(dialect)).map(
    ([dialect, root]) => [dialect, `${root}.${chain}`] as const,
  );
const hoppEnv = (method: string) =>
  ['hopp.env', 'hopp.env.active', 'hopp.env.global'].map((scope) => ['hoppscotch', `${scope}.${method}`] as const);

/** Each call, the statement it is written in (with `CALL` for the call) and the converted statement. */
const ROWS: readonly { name: string; calls: readonly (readonly [LayeredApi, string])[]; from: string; to: string }[] = [
  {
    name: 'writes',
    calls: [
      ...scoped('set'),
      ['bruno', 'bru.setVar'],
      ['bruno', 'bru.setEnvVar'],
      ['bruno', 'bru.setGlobalEnvVar'],
      ['thunder-client', 'tc.setVar'],
      ['hoppscotch', 'pw.env.set'],
      ...hoppEnv('set'),
      ['postman', 'postman.setEnvironmentVariable'],
      ['postman', 'postman.setGlobalVariable'],
    ],
    from: "CALL('token', id);",
    to: "vars.set('token', id);",
  },
  {
    name: 'reads',
    calls: [
      ...scoped('get'),
      ['bruno', 'bru.getVar'],
      ['bruno', 'bru.getEnvVar'],
      ['bruno', 'bru.getGlobalEnvVar'],
      ['bruno', 'bru.getCollectionVar'],
      ['bruno', 'bru.getFolderVar'],
      ['bruno', 'bru.getRequestVar'],
      ['thunder-client', 'tc.getVar'],
      ['hoppscotch', 'pw.env.get'],
      ['postman', 'postman.getEnvironmentVariable'],
      ['postman', 'postman.getGlobalVariable'],
    ],
    from: "const token = CALL('token').trim();",
    to: "const token = (vars.get('token') ?? props.get('token')).trim();",
  },
  {
    name: 'raw reads',
    calls: hoppEnv('getRaw'),
    from: "const token = CALL('token');",
    to: "const token = (vars.get('token') ?? props.get('token') ?? null);",
  },
  {
    name: 'has',
    calls: [...scoped('has'), ['bruno', 'bru.hasVar']],
    from: "const known = CALL('token');",
    to: "const known = (vars.get('token') ?? props.get('token')) !== undefined;",
  },
  {
    name: 'setNextRequest',
    calls: [
      ...pmShaped('execution.setNextRequest', ['postman', 'insomnia']),
      ['postman', 'postman.setNextRequest'],
      ['bruno', 'bru.setNextRequest'],
    ],
    from: "CALL('Login');",
    to: "execution.setNextRequest('Login');",
  },
  {
    name: 'skipRequest',
    calls: [
      ...pmShaped('execution.skipRequest', ['postman', 'insomnia']),
      ['bruno', 'bru.runner.skipRequest'],
      ['thunder-client', 'tc.skipRequest'],
    ],
    from: 'if (done) CALL();',
    to: 'if (done) execution.skipRequest();',
  },
  {
    name: 'stopExecution',
    calls: [['bruno', 'bru.runner.stopExecution']],
    from: 'CALL();',
    to: 'execution.setNextRequest(null);',
  },
  {
    name: 'iteration',
    calls: [...pmShaped('info.iteration'), ['thunder-client', 'tc.info.currentIteration']],
    from: 'const n = CALL + 1;',
    to: 'const n = iteration.index + 1;',
  },
  {
    name: 'iterationCount',
    calls: [...pmShaped('info.iterationCount'), ['thunder-client', 'tc.info.totalIterations']],
    from: 'const n = CALL;',
    to: 'const n = iteration.count;',
  },
  {
    name: 'iterationData.get',
    calls: pmShaped('iterationData.get', ['postman', 'insomnia']),
    from: "const user = CALL('user');",
    to: "const user = iteration.data.get('user');",
  },
];

describe('variable, run-control and iteration rows', () => {
  for (const row of ROWS) {
    describe(row.name, () => {
      for (const protocol of PROTOCOLS) {
        it.each(row.calls.map(([dialect, call]) => ({ dialect, call })))(
          `$call ($dialect) on ${protocol}`,
          ({ dialect, call }) => {
            const result = converted(dialect, `${row.from.replace('CALL', call)}\n`, protocol);
            expect(result.body).toBe(`${row.to}\n`);
            expect(result.todos).toEqual([]);
            expect(result.mapped).toBe(1);
          },
        );
      }
    });
  }

  it('converts a call nested in an argument', () => {
    expect(converted('postman', "pm.environment.set('b', pm.environment.get('a'));\n").body).toBe(
      "vars.set('b', (vars.get('a') ?? props.get('a')));\n",
    );
  });

  it('parenthesises has where its position needs it', () => {
    expect(converted('bruno', "if (!bru.hasVar('a') && bru.hasVar('b')) x();\n").body).toBe(
      "if (!((vars.get('a') ?? props.get('a')) !== undefined) && (vars.get('b') ?? props.get('b')) !== undefined) x();\n",
    );
  });

  it('drops a literal scope or options argument, and leaves any other one as a TODO', () => {
    expect(converted('thunder-client', "tc.setVar('a', 1, 'global');\n").body).toBe("vars.set('a', 1);\n");
    expect(converted('bruno', "bru.setEnvVar('a', 1, { persist: true });\n").body).toBe("vars.set('a', 1);\n");
    expect(converted('thunder-client', "tc.setVar('a', 1, scope);\n").body).toBe(
      "// TODO(convert): tc.setVar — not converted yet\n// tc.setVar('a', 1, scope);\n",
    );
  });

  it('leaves a call with the wrong number of arguments, or a property written to, as a TODO', () => {
    expect(converted('postman', 'pm.environment.get();\n').todos.map((t) => t.call)).toEqual(['pm.environment.get']);
    expect(converted('postman', "pm.environment.set('a');\n").todos.map((t) => t.call)).toEqual(['pm.environment.set']);
    expect(converted('postman', 'pm.info.iteration = 2;\n').todos.map((t) => t.call)).toEqual(['pm.info.iteration']);
  });

  it('is the default matcher of convertLevelScripts', () => {
    const result = convertLevelScripts({
      dialect: 'bruno',
      protocol: 'soap',
      pre: "bru.setVar('a', bru.getVar('b'));\n",
      post: 'bru.runner.stopExecution();\n',
      backups: {},
    });
    expect(result).toEqual({
      ok: true,
      pre: "// Converted from a bruno script.\nvars.set('a', (vars.get('b') ?? props.get('b')));\n",
      post: '// Converted from a bruno script.\nexecution.setNextRequest(null);\n',
      todos: [],
      mapped: 3,
    });
  });
});

describe('skipRequest in a post-response script is a TODO', () => {
  it.each([
    ['postman', 'pm.execution.skipRequest'],
    ['insomnia', 'insomnia.execution.skipRequest'],
    ['insomnia', '$.execution.skipRequest'],
    ['bruno', 'bru.runner.skipRequest'],
    ['thunder-client', 'tc.skipRequest'],
  ] as const)('%s: %s', (dialect, call) => {
    for (const protocol of PROTOCOLS) {
      const result = converted(dialect, `${call}();\n`, protocol, 'post');
      expect(result.body).toBe(`// TODO(convert): ${call} — ${SKIP_REQUEST_PRE_ONLY}\n// ${call}();\n`);
      expect(result.todos).toEqual([
        { phase: 'post', line: 2, call, kind: 'unsupported', reason: SKIP_REQUEST_PRE_ONLY },
      ]);
      expect(result.mapped).toBe(0);
    }
  });

  it("carries the reason the typed API's own skipRequest throws", () => {
    expect(SKIP_REQUEST_PRE_ONLY).toBe('execution.skipRequest works only in a pre-request script');
  });
});

describe('calls the layer refuses stay TODOs with its reason, whatever the table says', () => {
  it.each([
    'pm.collectionVariables.set',
    'pm.execution.setNextRequest',
    'pm.execution.skipRequest',
    'pm.iterationData.get',
  ])('hoppscotch %s', (call) => {
    const result = converted('hoppscotch', `${call}('a', 'b');\n`);
    expect(result.todos.map(({ kind, reason }) => [kind, reason])).toEqual([
      ['unsupported', 'the pm object of these scripts does not have it'],
    ]);
  });
});

describe("clear is refused with the layer's reason", () => {
  for (const protocol of PROTOCOLS) {
    it.each(scoped('clear').map(([dialect, call]) => ({ dialect, call })))(
      `$call ($dialect) on ${protocol}`,
      ({ dialect, call }) => {
        const result = converted(dialect, `${call}();\n`, protocol);
        expect(result.body).toBe(`// TODO(convert): ${call} — ${UNSUPPORTED_WHY.values}\n// ${call}();\n`);
        expect(result.todos).toEqual([
          { phase: 'pre', line: 2, call, kind: 'unsupported', reason: UNSUPPORTED_WHY.values },
        ]);
      },
    );
  }

  it('is the reason the layer throws', () => {
    expect(PART_VARIABLES).toContain("clear: unsupported('Clearing variables', WHY.values)");
  });
});

describe('a read writes its argument twice, so the argument must be free of side effects', () => {
  it.each([
    ["pm.environment.get('a')", "(vars.get('a') ?? props.get('a'))"],
    ['pm.environment.get(name)', '(vars.get(name) ?? props.get(name))'],
    ['pm.environment.get(cfg.keys.token)', '(vars.get(cfg.keys.token) ?? props.get(cfg.keys.token))'],
    ["pm.environment.get(cfg['token'])", "(vars.get(cfg['token']) ?? props.get(cfg['token']))"],
    ['pm.environment.get(keys[i])', '(vars.get(keys[i]) ?? props.get(keys[i]))'],
    ['pm.environment.has(keys[0])', '(vars.get(keys[0]) ?? props.get(keys[0])) !== undefined'],
  ])('%s is converted', (call, out) => {
    expect(converted('postman', `const v = ${call};\n`).body).toBe(`const v = ${out};\n`);
  });

  it.each([
    ['postman', 'pm.environment.get(keys.shift())'],
    ['postman', 'pm.environment.get(`${prefix}token`)'],
    ['postman', 'pm.environment.get(i++)'],
    ['postman', 'pm.environment.get(keys[i++])'],
    ['postman', "pm.environment.get(pm.environment.get('k'))"],
    ['postman', 'pm.environment.has(next())'],
    ['bruno', "bru.getVar('a' + n)"],
    ['bruno', 'bru.hasVar(name())'],
    ['thunder-client', 'tc.getVar(f())'],
    ['hoppscotch', 'pw.env.get(f())'],
    ['hoppscotch', 'hopp.env.getRaw(f())'],
    ['postman', 'postman.getEnvironmentVariable(f())'],
  ] as const)('%s: %s is a TODO', (dialect, call) => {
    const result = converted(dialect, `const v = ${call};\n`);
    const name = call.slice(0, call.indexOf('('));
    expect(result.body).toBe(`// TODO(convert): ${name} — not converted yet\n// const v = ${call};\n`);
    expect(result.todos.map(({ call: c, kind }) => [c, kind])).toEqual([[name, 'not-mapped']]);
  });
});

describe('the calls §6.3 and §6.7 do not map become TODOs', () => {
  it.each([
    ['postman', "pm.environment.unset('a');"],
    ['insomnia', "insomnia.baseEnvironment.unset('a');"],
    ['bruno', "bru.deleteVar('a');"],
    ['hoppscotch', "hopp.env.get('a');"],
    ['hoppscotch', "hopp.env.active.get('a');"],
    ['hoppscotch', "pw.env.resolve('<<a>>');"],
    ['postman', "pm.variables.replaceIn('{{a}}');"],
    ['bruno', "bru.interpolate('{{a}}');"],
    ['thunder-client', "tc.replaceVars('{{a}}');"],
    ['postman', 'log(pm.info.requestName);'],
    ['insomnia', 'log($.info.eventName);'],
    ['bruno', 'log(req.getName());'],
    ['thunder-client', 'log(tc.info.requestName);'],
    ['postman', 'log(pm.iterationData.toObject());'],
    ['bruno', 'log(bru.getEnvName());'],
    ['bruno', 'log(bru.getCollectionName());'],
    ['thunder-client', 'log(tc.info.environmentName);'],
    ['thunder-client', 'log(tc.info.collectionName);'],
    ['thunder-client', 'log(tc.info.folderName);'],
  ] as const)('%s: %s', (dialect, statement) => {
    for (const protocol of PROTOCOLS) {
      const result = converted(dialect, `${statement}\n`, protocol);
      const call = /[\w$]+(?:\.\w+)+/.exec(statement)?.[0] ?? '';
      expect(result.body).toBe(`// TODO(convert): ${call} — not converted yet\n// ${statement}\n`);
      expect(result.todos).toEqual([{ phase: 'pre', line: 2, call, kind: 'not-mapped', reason: 'not converted yet' }]);
    }
  });
});
