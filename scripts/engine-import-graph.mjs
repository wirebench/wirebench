/**
 * The import graph of `packages/engine/src`, by group (protocol modules spec §7).
 *
 * Every folder of the engine belongs to one group: a protocol (`soap`, `rest`, `grpc`, `ws`) or
 * `core`. Two rules hold between them:
 *
 *  1. a protocol group imports core and itself, never another protocol group;
 *  2. core imports no protocol group, except the edges listed in {@link CORE_EXCEPTIONS}.
 *
 * `node scripts/engine-import-graph.mjs` prints every import that leaves its group for a protocol
 * group, one per line: `[core->rest] project/history.ts -> rest/sse.ts : SseRow (type-only)`.
 * `--check` prints only what breaks a rule and exits non-zero when anything does; an exception that
 * no import uses any more breaks it too, so the list cannot outlive its reasons. `--json` prints the
 * same as JSON. `--src <dir>` reads another tree (the test's fixture).
 *
 * Wired into `pnpm check` as `pnpm check:engine-layers`. `eslint.config.js` builds its
 * `no-restricted-imports` blocks from the same {@link GROUP_FOLDERS} and {@link CORE_EXCEPTIONS}, so
 * an editor flags a wrong import as it is typed; this script is the exact gate, because it resolves
 * each import to a file, tells a type-only import from a value import, and sees `import()` types.
 *
 * A plain `.mjs` file so that `eslint.config.js` can import it under any Node version.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

/** The top-level folders of `packages/engine/src` that make up each protocol group (spec §7.1). */
export const GROUP_FOLDERS = Object.freeze({
  soap: ['soap', 'wsdl', 'xsd', 'wss', 'wsa', 'validate'],
  rest: ['rest', 'webhooks'],
  grpc: ['grpc'],
  ws: ['ws', 'asyncapi'],
});

/**
 * One import core is allowed to make of a protocol group.
 *
 * @typedef {object} CoreException
 * @property {string} from the importing file, relative to the source root
 * @property {string} to the imported file; a value ending in `/` allows every file under that
 *   folder, and `*` allows any protocol file
 * @property {boolean} [typeOnly] when true, only a type-only import is allowed
 * @property {string} until what removes the exception
 */

/**
 * The imports core makes of a protocol group (spec §7.2, rule 2). Rule 1 has no exceptions.
 *
 * Two kinds, told apart by `until`: the two files that are what they are (`protocols.ts`,
 * `index.ts`); and the project model, History, the loader and the writer, which hold protocol
 * types until the phases of #184 that split them.
 *
 * The spec's table also names `project/save.ts`; it imports no protocol folder, so it has no entry
 * here, and an entry nothing uses fails the check.
 *
 * @type {readonly CoreException[]}
 */
export const CORE_EXCEPTIONS = Object.freeze([
  { from: 'protocols.ts', to: '*', until: 'stays: the composition file' },
  { from: 'index.ts', to: '*', until: 'stays: the public exports' },
  { from: 'project/schema.ts', to: 'wss/model.ts', until: 'phase 3' },
  { from: 'project/model.ts', to: 'rest/model.ts', typeOnly: true, until: 'phase 3' },
  { from: 'project/model.ts', to: 'grpc/model.ts', typeOnly: true, until: 'phase 3' },
  { from: 'project/model.ts', to: 'ws/model.ts', typeOnly: true, until: 'phase 3' },
  { from: 'project/model.ts', to: 'webhooks/model.ts', typeOnly: true, until: 'phase 3' },
  { from: 'project/model.ts', to: 'wsa/model.ts', until: 'phase 3' },
  { from: 'project/history.ts', to: 'ws/model.ts', typeOnly: true, until: 'phase 2' },
  { from: 'project/history.ts', to: 'ws/transcript.ts', until: 'phase 2' },
  { from: 'project/history.ts', to: 'rest/sse.ts', typeOnly: true, until: 'phase 2' },
  { from: 'project/history.ts', to: 'rest/sse-transcript.ts', until: 'phase 2' },
  { from: 'project/history.ts', to: 'rest/contract-check.ts', until: 'phase 2' },
  { from: 'project/load.ts', to: 'rest/', until: 'phase 3' },
  { from: 'project/load.ts', to: 'webhooks/', until: 'phase 3' },
  { from: 'project/serialize.ts', to: 'rest/', until: 'phase 3' },
  { from: 'project/serialize.ts', to: 'webhooks/', until: 'phase 3' },
  { from: 'project/request-location.ts', to: 'rest/model.ts', typeOnly: true, until: 'phase 3' },
  { from: 'secrets/scan/walk.ts', to: 'rest/model.ts', typeOnly: true, until: 'phase 3' },
  { from: 'secrets/scan/walk.ts', to: 'grpc/model.ts', typeOnly: true, until: 'phase 3' },
  { from: 'secrets/scan/walk.ts', to: 'ws/model.ts', typeOnly: true, until: 'phase 3' },
  { from: 'secrets/scan/apply.ts', to: 'rest/model.ts', typeOnly: true, until: 'phase 3' },
  { from: 'import-detect.ts', to: 'rest/postman/parse.ts', until: 'phase 7' },
  { from: 'import-detect.ts', to: 'soap/legacy-project/format.ts', until: 'phase 7' },
]);

/**
 * One import that leaves its group for a protocol group.
 *
 * @typedef {object} Edge
 * @property {string} from the importing file, relative to the source root, `/`-separated
 * @property {string} to the imported file, likewise
 * @property {string} fromGroup
 * @property {string} toGroup
 * @property {readonly string[]} names the imported names, as the imported file exports them
 * @property {boolean} typeOnly true when the import disappears at build time
 */

/**
 * The group a source file belongs to.
 *
 * @param {string} file relative to the source root, `/`-separated
 * @returns {string} `soap`, `rest`, `grpc`, `ws` or `core`
 */
export function groupOf(file) {
  const slash = file.indexOf('/');
  const top = slash === -1 ? '' : file.slice(0, slash);
  for (const [group, folders] of Object.entries(GROUP_FOLDERS)) {
    if (folders.includes(top)) {
      return group;
    }
  }
  return 'core';
}

/**
 * Every `.ts` file under `dir`, sorted.
 *
 * @param {string} dir
 * @returns {string[]}
 */
function sourceFiles(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...sourceFiles(path));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      found.push(path);
    }
  }
  return found.sort();
}

/**
 * The file a relative specifier names, as the engine writes them (`'../rest/model.js'`).
 *
 * @param {string} importer absolute path of the importing file
 * @param {string} specifier
 * @returns {string | undefined}
 */
function resolveSpecifier(importer, specifier) {
  const base = resolve(dirname(importer), specifier);
  const candidates = [base.replace(/\.js$/, '.ts'), `${base}.ts`, join(base, 'index.ts')];
  return candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
}

/**
 * Every module a file names: static imports, re-exports, `import()` calls and `import()` types.
 *
 * @param {string} file absolute path
 * @returns {{ specifier: string, names: string[], typeOnly: boolean }[]}
 */
function importsOf(file) {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  /** @type {{ specifier: string, names: string[], typeOnly: boolean }[]} */
  const found = [];
  /** @param {import('typescript').Node} node */
  const visit = (node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      const names = [];
      let typeOnly = clause?.isTypeOnly ?? false;
      if (clause === undefined) {
        names.push('(side effect)');
      } else {
        if (clause.name !== undefined) {
          names.push('default');
        }
        const bindings = clause.namedBindings;
        if (bindings !== undefined && ts.isNamespaceImport(bindings)) {
          names.push('*');
        }
        if (bindings !== undefined && ts.isNamedImports(bindings)) {
          for (const element of bindings.elements) {
            names.push((element.propertyName ?? element.name).text);
          }
          const allTyped = bindings.elements.length > 0 && bindings.elements.every((element) => element.isTypeOnly);
          typeOnly = typeOnly || (clause.name === undefined && allTyped);
        }
      }
      found.push({ specifier: node.moduleSpecifier.text, names, typeOnly });
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const clause = node.exportClause;
      const names = [];
      let typeOnly = node.isTypeOnly;
      if (clause === undefined || ts.isNamespaceExport(clause)) {
        names.push('*');
      } else {
        for (const element of clause.elements) {
          names.push((element.propertyName ?? element.name).text);
        }
        typeOnly = typeOnly || (clause.elements.length > 0 && clause.elements.every((element) => element.isTypeOnly));
      }
      found.push({ specifier: node.moduleSpecifier.text, names, typeOnly });
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    ) {
      const name = node.qualifier === undefined ? '*' : node.qualifier.getText(source);
      found.push({ specifier: node.argument.literal.text, names: [name], typeOnly: true });
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] !== undefined &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      found.push({ specifier: node.arguments[0].text, names: ['(dynamic)'], typeOnly: false });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/**
 * Walks `srcDir` and returns every import that leaves its group for a protocol group, plus the
 * relative imports that name no file.
 *
 * @param {string} srcDir
 * @returns {{ edges: Edge[], unresolved: string[] }}
 */
export function collectEdges(srcDir) {
  const root = resolve(srcDir);
  /** @type {Edge[]} */
  const edges = [];
  /** @type {string[]} */
  const unresolved = [];
  for (const file of sourceFiles(root)) {
    const from = relative(root, file).split(sep).join('/');
    for (const found of importsOf(file)) {
      if (!found.specifier.startsWith('.')) {
        continue;
      }
      const target = resolveSpecifier(file, found.specifier);
      if (target === undefined) {
        unresolved.push(`${from} -> ${found.specifier}`);
        continue;
      }
      const to = relative(root, target).split(sep).join('/');
      const fromGroup = groupOf(from);
      const toGroup = groupOf(to);
      if (toGroup !== 'core' && toGroup !== fromGroup) {
        edges.push({ from, to, fromGroup, toGroup, names: found.names, typeOnly: found.typeOnly });
      }
    }
  }
  return { edges, unresolved };
}

/**
 * @param {CoreException} exception
 * @param {Edge} edge
 * @returns {boolean}
 */
function allows(exception, edge) {
  if (exception.from !== edge.from || (exception.typeOnly === true && !edge.typeOnly)) {
    return false;
  }
  if (exception.to === '*') {
    return true;
  }
  return exception.to.endsWith('/') ? edge.to.startsWith(exception.to) : edge.to === exception.to;
}

/**
 * Splits `edges` into what the rules allow and what they do not.
 *
 * @param {readonly Edge[]} edges
 * @param {readonly CoreException[]} [exceptions]
 * @returns {{ violations: Edge[], stale: CoreException[] }} `violations` break rule 1 or rule 2;
 *   `stale` are exceptions no edge uses
 */
export function checkEdges(edges, exceptions = CORE_EXCEPTIONS) {
  const used = new Set();
  const violations = edges.filter((edge) => {
    if (edge.fromGroup !== 'core') {
      return true;
    }
    const matching = exceptions.filter((exception) => allows(exception, edge));
    for (const exception of matching) {
      used.add(exception);
    }
    return matching.length === 0;
  });
  return { violations, stale: exceptions.filter((exception) => !used.has(exception)) };
}

/**
 * One edge as a line of the report.
 *
 * @param {Edge} edge
 * @returns {string}
 */
export function formatEdge(edge) {
  const names = edge.names.join(', ');
  const suffix = edge.typeOnly ? ' (type-only)' : '';
  return `[${edge.fromGroup}->${edge.toGroup}] ${edge.from} -> ${edge.to} : ${names}${suffix}`;
}

/** @param {readonly string[]} argv */
function main(argv) {
  const srcFlag = argv.indexOf('--src');
  const srcDir =
    srcFlag === -1
      ? fileURLToPath(new URL('../packages/engine/src', import.meta.url))
      : resolve(argv[srcFlag + 1] ?? '.');
  const { edges, unresolved } = collectEdges(srcDir);
  const { violations, stale } = checkEdges(edges);

  if (argv.includes('--json')) {
    console.log(JSON.stringify({ edges, violations, stale, unresolved }, null, 2));
  } else if (argv.includes('--check')) {
    for (const edge of violations) {
      const rule =
        edge.fromGroup === 'core' ? 'rule 2: core imports no protocol group' : 'rule 1: no other protocol group';
      console.error(`${formatEdge(edge)}\n    breaks ${rule} (protocol modules spec §7.2)`);
    }
    for (const exception of stale) {
      console.error(`stale exception: ${exception.from} -> ${exception.to} is no longer imported; remove it`);
    }
    for (const line of unresolved) {
      console.error(`unresolved import: ${line}`);
    }
    const allowed = edges.length - violations.length;
    console.log(
      `engine layers: ${String(violations.length)} violation(s), ${String(stale.length)} stale exception(s), ` +
        `${String(allowed)} allowed import(s) from core`,
    );
  } else {
    for (const edge of edges) {
      console.log(formatEdge(edge));
    }
    console.log(`${String(edges.length)} cross-group import(s)`);
  }

  if (argv.includes('--check') && violations.length + stale.length + unresolved.length > 0) {
    process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2));
}
