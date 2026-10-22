/**
 * The import graph of `packages/engine/src`, by group (protocol modules spec §7; package split spec §3.1).
 *
 * Every file of the engine belongs to one group: a protocol (`soap`, `rest`, `grpc`, `ws`, `mcp`),
 * `compose` (the files that compose every protocol: the public exports, the composition file, the
 * published file list, format detection, the exporters and the client importers) or `core`. Three
 * rules hold between them, with no exceptions:
 *
 *  1. a protocol group imports core and itself, never another protocol group;
 *  2. core imports core;
 *  3. compose imports anything, and nothing imports compose.
 *
 * And one more, for every group: no file imports Electron, React or the desktop (`BANNED_PACKAGES`);
 * `eslint.config.js` says the same for `packages/engine/**` and this script says it for the packages
 * the split adds (ADR-0030).
 *
 * `node scripts/engine-import-graph.mjs` prints every import that leaves its group, one per line:
 * `[core->rest] project/history.ts -> rest/model.ts : RestRequest (type-only)`. `--check` prints only
 * what breaks a rule and exits non-zero when anything does. `--json` prints the same as JSON. `--src
 * <dir>` reads another tree (the test's fixture).
 *
 * Wired into `pnpm check` as `pnpm check:engine-layers`, which is the only enforcement: there is no
 * lint rule for these imports, so an editor does not flag a wrong import. The script is exact because
 * it resolves each import to a file, tells a type-only import from a value import, and sees
 * `import()` types.
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
  mcp: ['mcp'],
});

/**
 * The files and folders of the compose group (package split spec §3.1): what becomes the `engine`
 * package when the folders become packages. A folder entry ends with `/` and covers every file under it.
 */
export const COMPOSE = Object.freeze([
  'index.ts',
  'protocols.ts',
  'project-files.ts',
  'import-detect.ts',
  'export/',
  'import/index.ts',
  'import/client-import.ts',
  'import/read-folder.ts',
  'import/bruno/',
  'import/collection-v3/',
  'import/hoppscotch/',
  'import/http-file/',
  'import/insomnia/',
  'import/opencollection/',
  'import/thunder/',
]);

/** Bare imports no engine file may make: the engine stays free of Electron and React. */
export const BANNED_PACKAGES = Object.freeze(['electron', 'react', 'react-dom', '@wirebench/desktop']);

/**
 * One import of a package no engine file may import.
 *
 * @typedef {object} BannedImport
 * @property {string} from the importing file, relative to the source root
 * @property {string} specifier the import as written
 */

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
 * @returns {string} `soap`, `rest`, `grpc`, `ws`, `mcp`, `compose` or `core`
 */
export function groupOf(file) {
  if (COMPOSE.some((entry) => (entry.endsWith('/') ? file.startsWith(entry) : file === entry))) {
    return 'compose';
  }
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
 * Walks `srcDir` and returns every import that leaves its group for a group other than core, every
 * import of a banned package, and the relative imports that name no file.
 *
 * @param {string} srcDir
 * @returns {{ edges: Edge[], banned: BannedImport[], unresolved: string[] }}
 */
export function collectEdges(srcDir) {
  const root = resolve(srcDir);
  /** @type {Edge[]} */
  const edges = [];
  /** @type {BannedImport[]} */
  const banned = [];
  /** @type {string[]} */
  const unresolved = [];
  for (const file of sourceFiles(root)) {
    const from = relative(root, file).split(sep).join('/');
    for (const found of importsOf(file)) {
      if (!found.specifier.startsWith('.')) {
        const bare = found.specifier.startsWith('@')
          ? found.specifier.split('/').slice(0, 2).join('/')
          : found.specifier.split('/')[0];
        if (bare !== undefined && BANNED_PACKAGES.includes(bare)) {
          banned.push({ from, specifier: found.specifier });
        }
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
  return { edges, banned, unresolved };
}

/**
 * The rule an edge breaks, or undefined when the rules allow it.
 *
 * @param {Edge} edge
 * @returns {string | undefined}
 */
export function ruleBroken(edge) {
  if (edge.fromGroup === 'compose') {
    return undefined;
  }
  if (edge.toGroup === 'compose') {
    return 'rule 3: nothing imports compose';
  }
  return edge.fromGroup === 'core' ? 'rule 2: core imports no protocol group' : 'rule 1: no other protocol group';
}

/**
 * The edges that break a rule.
 *
 * @param {readonly Edge[]} edges
 * @returns {Edge[]}
 */
export function checkEdges(edges) {
  return edges.filter((edge) => ruleBroken(edge) !== undefined);
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
  const { edges, banned, unresolved } = collectEdges(srcDir);
  const violations = checkEdges(edges);

  if (argv.includes('--json')) {
    console.log(JSON.stringify({ edges, violations, banned, unresolved }, null, 2));
  } else if (argv.includes('--check')) {
    for (const edge of violations) {
      console.error(`${formatEdge(edge)}\n    breaks ${ruleBroken(edge) ?? ''} (package split spec §3.1)`);
    }
    for (const entry of banned) {
      console.error(`banned import: ${entry.from} -> ${entry.specifier} (the engine stays free of Electron and React)`);
    }
    for (const line of unresolved) {
      console.error(`unresolved import: ${line}`);
    }
    const allowed = edges.length - violations.length;
    console.log(
      `engine layers: ${String(violations.length)} violation(s), ${String(banned.length)} banned import(s), ` +
        `${String(allowed)} import(s) from compose`,
    );
  } else {
    for (const edge of edges) {
      console.log(formatEdge(edge));
    }
    console.log(`${String(edges.length)} cross-group import(s)`);
  }

  if (argv.includes('--check') && violations.length + banned.length + unresolved.length > 0) {
    process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2));
}
