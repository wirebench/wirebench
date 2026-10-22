/**
 * The converter's skeleton (spec §5): it parses a level's scripts, finds the dialect's roots, asks a
 * matcher for each call on one, and turns what is left into TODOs with the statement commented out.
 * Calls with no row (`bru.unknown`) are TODOs; the matcher seam is driven by a stand-in matcher.
 */
import { createContext, runInContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { unsupportedCall, UNSUPPORTED_CALLS } from '#core/import/scripts';
import { SCRIPT_LAYERS } from '#core/script/api/layers';
import { PART_UNSUPPORTED, UNSUPPORTED_DEFAULT_REASON, UNSUPPORTED_WHY } from '#core/script/api/layer-parts';
import { convertLevelScripts, convertScript } from '#core/script/convert/index';
import type { Matcher } from '#core/script/convert/roots';
import { TOP_LEVEL_IMPORT_REASON } from '#core/script/module-syntax';
import { typescript } from '#core/script/convert/typescript';

const header = (dialect: string, path: string): string =>
  `// Converted from a ${dialect} script; the original is in ${path}.`;

describe('convertLevelScripts', () => {
  it('a syntax error is refused with its phase and line', () => {
    const result = convertLevelScripts({
      dialect: 'postman',
      protocol: 'rest',
      pre: 'const a = 1;\n',
      post: 'const a = 1;\nconst b = ;\n',
      backups: {},
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.phase).toBe('post');
    expect(result.line).toBe(2);
    expect(result.message).toMatch(/expression expected/i);
  });

  it('a script with no dialect call is unchanged apart from the header', () => {
    const pre = "const a = 1;\nconsole.log(a, 'bru.setVar(1)');\n";
    const result = convertLevelScripts({
      dialect: 'bruno',
      protocol: 'rest',
      pre,
      backups: { pre: 'imported-scripts/users/create.pre.js' },
    });
    expect(result).toEqual({
      ok: true,
      pre: `${header('bruno', 'imported-scripts/users/create.pre.js')}\n${pre}`,
      todos: [],
      mapped: 0,
    });
  });

  it('names the dialect alone when the phase has no backup, and has no file for a phase with no script', () => {
    const result = convertLevelScripts({ dialect: 'insomnia', protocol: 'rest', post: 'let a = 1;\n', backups: {} });
    expect(result).toEqual({
      ok: true,
      post: '// Converted from an insomnia script.\nlet a = 1;\n',
      todos: [],
      mapped: 0,
    });
  });

  it('an unknown call on a root becomes a TODO, and its innermost statement is commented out', () => {
    const post = [
      'const id = 1;',
      'if (id) {',
      "  bru.unknown('id', id);",
      '  bru.unknown(',
      "    'other',",
      '    id,',
      '  );',
      '}',
      '',
    ].join('\n');
    const result = convertLevelScripts({
      dialect: 'bruno',
      protocol: 'rest',
      post,
      backups: { post: 'imported-scripts/a/b.post.js' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.post).toBe(
      [
        header('bruno', 'imported-scripts/a/b.post.js'),
        'const id = 1;',
        'if (id) {',
        '  // TODO(convert): bru.unknown — not converted yet',
        "  // bru.unknown('id', id);",
        '  // TODO(convert): bru.unknown — not converted yet',
        '  // bru.unknown(',
        "  //   'other',",
        '  //   id,',
        '  // );',
        '}',
        '',
      ].join('\n'),
    );
    expect(result.todos).toEqual([
      { phase: 'post', line: 4, call: 'bru.unknown', kind: 'not-mapped', reason: 'not converted yet' },
      { phase: 'post', line: 6, call: 'bru.unknown', kind: 'not-mapped', reason: 'not converted yet' },
    ]);
    expect(result.mapped).toBe(0);
  });

  it('a statement that shares its line is moved to its own lines before it is commented out', () => {
    const result = convertLevelScripts({
      dialect: 'bruno',
      protocol: 'rest',
      pre: "  const a = 1; bru.unknown('a', a); console.log(a); // done\n",
      backups: {},
    });
    expect(result.ok && result.pre).toBe(
      [
        '// Converted from a bruno script.',
        '  const a = 1; ',
        '  // TODO(convert): bru.unknown — not converted yet',
        "  // bru.unknown('a', a);",
        '  console.log(a); // done',
        '',
      ].join('\n'),
    );
    expect(result.ok && result.todos.map((t) => t.line)).toEqual([3]);
  });

  it('a root the script declares is skipped, with one shadowed TODO', () => {
    const post = [
      'const expect = (v) => v;',
      'expect(1);',
      'function check(res) {',
      '  return res.status;',
      '}',
      '',
    ].join('\n');
    const result = convertLevelScripts({ dialect: 'bruno', protocol: 'rest', post, backups: {} });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.post).toBe(
      [
        '// Converted from a bruno script.',
        '// TODO(convert): res — the script declares its own res, so its uses were not converted',
        '// TODO(convert): expect — the script declares its own expect, so its uses were not converted',
        post,
      ].join('\n'),
    );
    expect(result.todos).toEqual([
      {
        phase: 'post',
        line: 2,
        call: 'res',
        kind: 'shadowed',
        reason: 'the script declares its own res, so its uses were not converted',
      },
      {
        phase: 'post',
        line: 3,
        call: 'expect',
        kind: 'shadowed',
        reason: 'the script declares its own expect, so its uses were not converted',
      },
    ]);
  });

  it('text inside strings, templates and comments is untouched', () => {
    const pre = [
      "const a = 'pm.sendRequest(x)';",
      'const b = `pm.environment.set("a", 1)`;',
      "// pm.test('x', () => {});",
      '/* pm.vault.get("x") */',
      'const c = "CryptoJS.MD5(a)";',
      '',
    ].join('\n');
    const result = convertLevelScripts({ dialect: 'postman', protocol: 'rest', pre, backups: {} });
    expect(result).toEqual({ ok: true, pre: `// Converted from a postman script.\n${pre}`, todos: [], mapped: 0 });
  });

  it('CRLF line ends are kept', () => {
    const result = convertLevelScripts({
      dialect: 'bruno',
      protocol: 'rest',
      pre: "const a = 1;\r\nif (a) {\r\n  bru.unknown('a',\r\n    a);\r\n}\r\n",
      backups: {},
    });
    expect(result.ok && result.pre).toBe(
      [
        '// Converted from a bruno script.',
        'const a = 1;',
        'if (a) {',
        '  // TODO(convert): bru.unknown — not converted yet',
        "  // bru.unknown('a',",
        '  //   a);',
        '}',
        '',
      ].join('\r\n'),
    );
  });

  it('a call inside a commented-out statement is not rewritten', () => {
    const pre = [
      'pm.sendRequest(tokenRequest, (err, res) => {',
      "  pm.environment.set('token', res.json().access_token);",
      '  pm.globals.clear();',
      '});',
      "pm.environment.set('a', '1');",
      '',
    ].join('\n');
    // A stand-in for the mapping table: it knows pm.environment.set and nothing else.
    const matcher: Matcher = (ref, context) =>
      ref.name === 'pm.environment.set' && ref.call !== undefined
        ? { node: ref.call, text: `vars.set(${ref.call.arguments.map((a) => context.text(a)).join(', ')})` }
        : undefined;
    const result = convertScript(
      { dialect: 'postman', protocol: 'rest', phase: 'pre', text: pre, backup: 'imported-scripts/a/b.pre.js' },
      matcher,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toBe(
      [
        header('postman', 'imported-scripts/a/b.pre.js'),
        '// TODO(convert): pm.sendRequest — a script cannot send requests',
        '// pm.sendRequest(tokenRequest, (err, res) => {',
        "//   pm.environment.set('token', res.json().access_token);",
        '//   pm.globals.clear();',
        '// });',
        "vars.set('a', '1');",
        '',
      ].join('\n'),
    );
    expect(result.todos).toEqual([
      { phase: 'pre', line: 2, call: 'pm.sendRequest', kind: 'unsupported', reason: 'a script cannot send requests' },
    ]);
    expect(result.mapped).toBe(1);
  });

  it("an unsupported call's TODO carries the layer's reason", () => {
    const pre = [
      'pm.sendRequest(tokenRequest, (err, res) => {',
      "  pm.environment.set('token', res.json().access_token);",
      '});',
      '',
    ].join('\n');
    const result = convertLevelScripts({
      dialect: 'postman',
      protocol: 'rest',
      pre,
      backups: { pre: 'imported-scripts/users-api/users-create-user.pre.js' },
    });
    expect(result).toEqual({
      ok: true,
      pre: [
        header('postman', 'imported-scripts/users-api/users-create-user.pre.js'),
        '// TODO(convert): pm.sendRequest — a script cannot send requests',
        '// pm.sendRequest(tokenRequest, (err, res) => {',
        "//   pm.environment.set('token', res.json().access_token);",
        '// });',
        '',
      ].join('\n'),
      todos: [
        {
          phase: 'pre',
          line: 2,
          call: 'pm.sendRequest',
          kind: 'unsupported',
          reason: 'a script cannot send requests',
        },
      ],
      mapped: 0,
    });
  });

  it('finds the unsupported calls that are not on a root, and a top-level import', () => {
    const thunder = convertLevelScripts({
      dialect: 'thunder-client',
      protocol: 'rest',
      post: "assert.equal(1, 1);\nconst m = require('thunder-tests/m.js');\ntc.skipRequest('Other');\n",
      backups: {},
    });
    expect(thunder.ok && thunder.todos.map(({ call, kind, reason }) => [call, kind, reason])).toEqual([
      ['assert', 'unsupported', 'use expect'],
      ['require("thunder-tests/...")', 'unsupported', 'a script cannot load modules'],
      ['tc.skipRequest with a request name', 'unsupported', 'a script can skip only its own request'],
    ]);
    const hopp = convertLevelScripts({
      dialect: 'hoppscotch',
      protocol: 'rest',
      pre: "import x from 'y';\nhopp.env.active.reset('a');\n",
      backups: {},
    });
    expect(hopp.ok && hopp.todos.map(({ call, reason }) => [call, reason])).toEqual([
      ['import', TOP_LEVEL_IMPORT_REASON],
      ['hopp.env.reset', 'a script cannot change initial values'],
    ]);
  });
});

describe('the matcher seam', () => {
  it('splices a replacement over exactly its node, converting the calls nested in it', () => {
    const matcher: Matcher = (ref, context) => {
      if (ref.call === undefined) return undefined;
      const args = ref.call.arguments.map((a) => context.text(a));
      if (ref.name === 'bru.setVar') return { node: ref.call, text: `vars.set(${args.join(', ')})` };
      if (ref.name === 'bru.getVar') return { node: ref.call, text: `vars.get(${args.join(', ')})` };
      return undefined;
    };
    const result = convertScript(
      {
        dialect: 'bruno',
        protocol: 'rest',
        phase: 'pre',
        text: "bru.setVar('a',   bru.getVar('b')); // keep\n",
      },
      matcher,
    );
    expect(result).toEqual({
      ok: true,
      text: "// Converted from a bruno script.\nvars.set('a', vars.get('b')); // keep\n",
      todos: [],
      mapped: 2,
    });
  });
});

/** True when `text` parses as a script, the parser's own diagnostics being empty. */
const parses = (text: string): boolean => {
  const ts = typescript();
  const file = ts.createSourceFile('out.js', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  return ((file as { parseDiagnostics?: readonly unknown[] }).parseDiagnostics ?? []).length === 0;
};

describe('the statement a TODO comments out', () => {
  it('is the innermost one: an else body alone is wrapped in braces and commented out', () => {
    const result = convertLevelScripts({
      dialect: 'bruno',
      protocol: 'rest',
      pre: "if (a) {\n  x();\n} else bru.unknown('a', 1);\n",
      backups: {},
    });
    expect(result.ok && result.pre).toBe(
      [
        '// Converted from a bruno script.',
        'if (a) {',
        '  x();',
        '} else {',
        '  // TODO(convert): bru.unknown — not converted yet',
        "  // bru.unknown('a', 1);",
        '}',
        '',
      ].join('\n'),
    );
    expect(result.ok && result.todos.map((todo) => todo.line)).toEqual([5]);
    expect(result.ok && parses(result.pre ?? '')).toBe(true);
  });

  it('keeps an if or loop valid when its body was the statement', () => {
    const result = convertLevelScripts({
      dialect: 'postman',
      protocol: 'rest',
      pre: 'if (a) pm.x();\nif (b)\n  pm.y(1,\n    2);\nelse z();\nfor (const k of ks) pm.z(k); // each\n',
      backups: {},
    });
    expect(result.ok && result.pre).toBe(
      [
        '// Converted from a postman script.',
        'if (a) {',
        '  // TODO(convert): pm.x — not converted yet',
        '  // pm.x();',
        '}',
        'if (b) {',
        '  // TODO(convert): pm.y — not converted yet',
        '  // pm.y(1,',
        '  //   2);',
        '}',
        'else z();',
        'for (const k of ks) {',
        '  // TODO(convert): pm.z — not converted yet',
        '  // pm.z(k);',
        '} // each',
        '',
      ].join('\n'),
    );
    expect(result.ok && result.todos.map((todo) => todo.line)).toEqual([3, 7, 13]);
    expect(result.ok && parses(result.pre ?? '')).toBe(true);
  });
});

describe('what a replacement covers', () => {
  const run = (text: string, matcher: Matcher) =>
    convertScript({ dialect: 'postman', protocol: 'rest', phase: 'pre', text }, matcher);
  const ts = typescript();

  it('decides the references it replaces without handing on, as CryptoJS chains need', () => {
    // A stand-in for the CryptoJS row: the whole `CryptoJS.SHA256(x).toString(CryptoJS.enc.Base64)` chain.
    const matcher: Matcher = (ref, context) => {
      if (ref.name !== 'CryptoJS.SHA256' || ref.call === undefined) return undefined;
      const toString = ref.call.parent;
      if (!ts.isPropertyAccessExpression(toString) || !ts.isCallExpression(toString.parent)) return undefined;
      const [data] = ref.call.arguments;
      if (data === undefined) return undefined;
      return { node: toString.parent, text: `crypto.hash('sha256', ${context.text(data)}, 'base64')` };
    };
    expect(run('const h = CryptoJS.SHA256(a).toString(CryptoJS.enc.Base64);\n', matcher)).toEqual({
      ok: true,
      text: "// Converted from a postman script.\nconst h = crypto.hash('sha256', a, 'base64');\n",
      todos: [],
      mapped: 1,
    });
  });

  it('turns the statements in a body it hands on into TODOs inside the replacement', () => {
    const matcher: Matcher = (ref, context) =>
      ref.name === 'pm.test' && ref.call !== undefined
        ? { node: ref.call, text: `test(${ref.call.arguments.map((arg) => context.text(arg)).join(', ')})` }
        : undefined;
    const result = run("pm.test('a', () => {\n  pm.sendRequest(x);\n});\n", matcher);
    expect(result).toEqual({
      ok: true,
      text: [
        '// Converted from a postman script.',
        "test('a', () => {",
        '  // TODO(convert): pm.sendRequest — a script cannot send requests',
        '  // pm.sendRequest(x);',
        '});',
        '',
      ].join('\n'),
      todos: [
        { phase: 'pre', line: 3, call: 'pm.sendRequest', kind: 'unsupported', reason: 'a script cannot send requests' },
      ],
      mapped: 1,
    });
  });

  it('refuses a replacement that copies a body instead of handing it to context.text', () => {
    const copying: Matcher = (ref) =>
      ref.name === 'pm.test' && ref.call !== undefined
        ? { node: ref.call, text: `test(${ref.call.arguments.map((arg) => arg.getText()).join(', ')})` }
        : undefined;
    expect(() => run("pm.test('a', () => {\n  pm.sendRequest(x);\n});\n", copying)).toThrow(/pm\.sendRequest/);
    expect(() => run("pm.test('a', () => {\n  pm.globals.get('a');\n});\n", copying)).toThrow(/pm\.globals\.get/);
  });

  it('refuses a replacement that does not hold its reference', () => {
    const elsewhere: Matcher = (ref) =>
      ref.name === 'pm.a' ? { node: ref.node.getSourceFile().statements[1]!, text: 'x' } : undefined;
    expect(() => run('pm.a();\nfoo();\n', elsewhere)).toThrow(/does not hold it/);
  });
});

describe('the reasons a TODO gives', () => {
  it('UNSUPPORTED_WHY is the WHY the layers run', () => {
    class ScriptUnsupported extends Error {}
    const context = createContext({ ScriptUnsupported });
    const evaluated = runInContext(`${PART_UNSUPPORTED}; ({ WHY: { ...WHY }, unsupported })`, context) as {
      WHY: Record<string, string>;
      unsupported: (name: string) => () => void;
    };
    expect(evaluated.WHY).toEqual({ ...UNSUPPORTED_WHY });
    expect(() => evaluated.unsupported('x')()).toThrow(`x is not supported: ${UNSUPPORTED_DEFAULT_REASON}`);
  });

  it("every other reason an unsupported call gives is in its layer's source", () => {
    const shared = new Set<string>([
      ...Object.values(UNSUPPORTED_WHY),
      UNSUPPORTED_DEFAULT_REASON,
      TOP_LEVEL_IMPORT_REASON,
    ]);
    for (const [api, entries] of Object.entries(UNSUPPORTED_CALLS)) {
      for (const [, , reason] of entries) {
        if (reason !== undefined && !shared.has(reason))
          expect(SCRIPT_LAYERS[api as keyof typeof SCRIPT_LAYERS]).toContain(`'${reason}'`);
      }
    }
  });

  it('a call the layer runs is not named unsupported', () => {
    expect(unsupportedCall('pm.iterationData.get(x)', 'postman')).toBeUndefined();
    expect(unsupportedCall('pm.iterationData.get(x)', 'hoppscotch')).toEqual({
      name: 'pm.iterationData',
      reason: 'the pm object of these scripts does not have it',
    });
  });
});

describe("Hoppscotch's export {} line", () => {
  it('is dropped as the runner drops it, keeping the line count', () => {
    const pre = 'export {};\npw.unknown(1);\n  export {}  \nconst a = 1;\n';
    const result = convertLevelScripts({ dialect: 'hoppscotch', protocol: 'rest', pre, backups: {} });
    expect(result).toEqual({
      ok: true,
      pre: [
        '// Converted from a hoppscotch script.',
        '',
        '// TODO(convert): pw.unknown — not converted yet',
        '// pw.unknown(1);',
        '',
        'const a = 1;',
        '',
      ].join('\n'),
      todos: [{ phase: 'pre', line: 3, call: 'pw.unknown', kind: 'not-mapped', reason: 'not converted yet' }],
      mapped: 0,
    });
  });

  it('is kept in another dialect, whose runner does not drop it', () => {
    const result = convertLevelScripts({ dialect: 'postman', protocol: 'rest', pre: 'export {};\n', backups: {} });
    expect(result.ok && result.pre).toBe('// Converted from a postman script.\nexport {};\n');
  });
});

describe('a script that cannot be converted', () => {
  const level = (pre: string, matcher?: Matcher) =>
    convertLevelScripts({ dialect: 'postman', protocol: 'rest', pre, backups: {} }, matcher);

  it.each([
    ['a 5 000-term concatenation', `const a = ${Array.from({ length: 5000 }, () => "'a'").join(' + ')};\n`],
    ['5 000 chained else-ifs', `if (a) x();\n${Array.from({ length: 5000 }, () => 'else if (a) x();').join('\n')}\n`],
    ['a 20 000-term concatenation', `const a = ${Array.from({ length: 20_000 }, () => "'a'").join(' + ')};\n`],
  ])('is refused, not thrown, when it nests too deep: %s', (_, pre) => {
    const result = level(pre);
    expect(result).toMatchObject({ ok: false, phase: 'pre', line: 0, message: /^could not convert: / });
  });

  it('is refused with the phase that failed', () => {
    const deep = `const a = ${Array.from({ length: 5000 }, () => "'a'").join(' + ')};\n`;
    const result = convertLevelScripts({
      dialect: 'postman',
      protocol: 'rest',
      pre: 'a();\n',
      post: deep,
      backups: {},
    });
    expect(result).toMatchObject({ ok: false, phase: 'post', line: 0 });
  });

  it('is refused when a replacement breaks the seam', () => {
    const elsewhere: Matcher = (ref) =>
      ref.name === 'pm.a' ? { node: ref.node.getSourceFile().statements[1]!, text: 'x' } : undefined;
    expect(level('pm.a();\nfoo();\n', elsewhere)).toEqual({
      ok: false,
      phase: 'pre',
      line: 0,
      message: 'could not convert: the replacement for pm.a does not hold it',
    });
  });

  it('a replacement that hands context.text a node holding its own reference is a clear error', () => {
    const itself: Matcher = (ref, context) =>
      ref.call === undefined ? undefined : { node: ref.call, text: context.text(ref.call) };
    const text = "pm.a('x');\n";
    expect(() => convertScript({ dialect: 'postman', protocol: 'rest', phase: 'pre', text }, itself)).toThrow(
      'convert: the replacement for pm.a hands context.text a node that holds pm.a itself',
    );
    expect(level(text, itself)).toMatchObject({
      ok: false,
      message: 'could not convert: the replacement for pm.a hands context.text a node that holds pm.a itself',
    });
  });
});
