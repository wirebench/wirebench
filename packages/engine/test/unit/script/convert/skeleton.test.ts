/**
 * The converter's skeleton (spec §5): it parses a level's scripts, finds the dialect's roots, asks a
 * matcher for each call on one, and turns what is left into TODOs with the statement commented out.
 * The mapping table is empty here, so every dialect call is a TODO; the matcher seam is driven by a
 * stand-in matcher.
 */
import { createContext, runInContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { unsupportedCall, UNSUPPORTED_CALLS } from '../../../../src/import/scripts.js';
import { SCRIPT_LAYERS } from '../../../../src/script/api/layers.js';
import {
  PART_UNSUPPORTED,
  UNSUPPORTED_DEFAULT_REASON,
  UNSUPPORTED_WHY,
} from '../../../../src/script/api/layer-parts.js';
import { convertLevelScripts, convertScript } from '../../../../src/script/convert/index.js';
import type { Matcher } from '../../../../src/script/convert/roots.js';
import { TOP_LEVEL_IMPORT_REASON } from '../../../../src/script/module-syntax.js';

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
      "  bru.setVar('id', id);",
      '  bru.setVar(',
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
        '  // TODO(convert): bru.setVar — not converted yet',
        "  // bru.setVar('id', id);",
        '  // TODO(convert): bru.setVar — not converted yet',
        '  // bru.setVar(',
        "  //   'other',",
        '  //   id,',
        '  // );',
        '}',
        '',
      ].join('\n'),
    );
    expect(result.todos).toEqual([
      { phase: 'post', line: 4, call: 'bru.setVar', kind: 'not-mapped', reason: 'not converted yet' },
      { phase: 'post', line: 6, call: 'bru.setVar', kind: 'not-mapped', reason: 'not converted yet' },
    ]);
    expect(result.mapped).toBe(0);
  });

  it('a statement that shares its line is moved to its own lines before it is commented out', () => {
    const result = convertLevelScripts({
      dialect: 'bruno',
      protocol: 'rest',
      pre: "  const a = 1; bru.setVar('a', a); console.log(a); // done\n",
      backups: {},
    });
    expect(result.ok && result.pre).toBe(
      [
        '// Converted from a bruno script.',
        '  const a = 1; ',
        '  // TODO(convert): bru.setVar — not converted yet',
        "  // bru.setVar('a', a);",
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
      pre: "const a = 1;\r\nif (a) {\r\n  bru.setVar('a',\r\n    a);\r\n}\r\n",
      backups: {},
    });
    expect(result.ok && result.pre).toBe(
      [
        '// Converted from a bruno script.',
        'const a = 1;',
        'if (a) {',
        '  // TODO(convert): bru.setVar — not converted yet',
        "  // bru.setVar('a',",
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
