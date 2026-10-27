/**
 * The import graph of the engine's packages, by package (package split spec §4; ADR-0030).
 *
 * The engine is eight workspace packages under `packages/`: `core`, one `protocol-<name>` per protocol
 * (`soap`, `rest`, `grpc`, `ws`, `mcp`, and `graphql`, a REST body kind in a package of its own, phase 6
 * spec §4) and `engine`, the composition. A package is a group, and three
 * rules hold between the groups, with no exceptions:
 *
 *  1. a protocol imports core and itself, never another protocol;
 *  2. core imports core;
 *  3. compose (`engine`) imports anything, and nothing imports compose.
 *
 * The rules hold for the imports a source file writes (`#core/…`, `#protocol-rest/…`, `@wirebench/…`)
 * and for the `@wirebench/*` entries of each package's manifest. Two more checks: a relative import
 * never leaves its package (`../../core/src/…` compiles under `tsc -b` only by accident and never from
 * `dist`), and no file imports Electron, React or the desktop (`BANNED_PACKAGES`), which
 * `eslint.config.js` also says for `packages/engine/**`.
 *
 * `node scripts/engine-import-graph.mjs` prints every import that crosses a package, one per line:
 * `[rest->core] rest/model.ts -> #core/project/model : Container (type-only)`. `--check` prints only
 * what breaks a rule and exits non-zero when anything does. `--json` prints the same as JSON.
 * `--root <dir>` reads another `packages/` tree (the test's fixture).
 *
 * Wired into `pnpm check` as `pnpm check:engine-layers`, which is the only enforcement: there is no
 * lint rule for these imports, so an editor does not flag a wrong import. The script is exact because
 * it resolves each relative import to a file, tells a type-only import from a value import, and sees
 * `import()` types.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

/** The packages under `packages/` that make up the engine, and the group each one is. */
export const PACKAGE_GROUPS = Object.freeze({
  core: 'core',
  'protocol-soap': 'soap',
  'protocol-rest': 'rest',
  'protocol-grpc': 'grpc',
  'protocol-ws': 'ws',
  'protocol-mcp': 'mcp',
  'protocol-graphql': 'graphql',
  engine: 'compose',
});

/** Bare imports no engine file may make: the engine stays free of Electron, React and the desktop wire code. */
export const BANNED_PACKAGES = Object.freeze([
  'electron',
  'react',
  'react-dom',
  '@wirebench/desktop',
  '@wirebench/wire',
]);

/**
 * One import of a package no engine file may import.
 *
 * @typedef {object} BannedImport
 * @property {string} from the importing file, `<package>/<path under src>` (or `<package>/package.json`)
 * @property {string} specifier the import as written
 */

/**
 * One import that crosses a package.
 *
 * @typedef {object} Edge
 * @property {string} from the importing file, `<package>/<path under src>`, `/`-separated; a manifest
 *   entry is `<package>/package.json`
 * @property {string} to the specifier as written, or the file a relative import names, relative to the
 *   packages root
 * @property {string} fromGroup
 * @property {string} toGroup a group, or `outside` for a relative import that leaves every package
 * @property {readonly string[]} names the imported names, as the imported file exports them
 * @property {boolean} typeOnly true when the import disappears at build time
 * @property {boolean} relative true for a relative import that left its package
 */

/**
 * The group a bare specifier names, or undefined when it names no engine package.
 *
 * @param {string} specifier `#core/project/model`, `@wirebench/protocol-rest/rest/model`, `@wirebench/engine`
 * @returns {string | undefined}
 */
export function groupOfSpecifier(specifier) {
  const match = /^(?:#|@wirebench\/)([a-z-]+)(?:\/|$)/.exec(specifier);
  const name = match?.[1];
  return name === undefined ? undefined : PACKAGE_GROUPS[name];
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
 * The imports of one file: static, re-exports, `import()` types and dynamic `import()` calls.
 *
 * @param {string} file absolute path
 * @returns {{ specifier: string, names: string[], typeOnly: boolean }[]}
 */
function importsOf(file) {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  /** @type {{ specifier: string, names: string[], typeOnly: boolean }[]} */
  const found = [];
  /** @param {ts.Node} node */
  const visit = (node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      /** @type {string[]} */
      const names = [];
      let typeOnly = clause?.isTypeOnly === true;
      if (clause?.namedBindings !== undefined && ts.isNamedImports(clause.namedBindings)) {
        for (const element of clause.namedBindings.elements) {
          names.push((element.propertyName ?? element.name).text);
        }
        typeOnly ||= clause.namedBindings.elements.every((element) => element.isTypeOnly);
      } else if (clause?.namedBindings !== undefined) {
        names.push('*');
      } else if (clause?.name !== undefined) {
        names.push('default');
      } else {
        names.push('(side effect)');
      }
      found.push({ specifier: node.moduleSpecifier.text, names, typeOnly });
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const clause = node.exportClause;
      const names =
        clause !== undefined && ts.isNamedExports(clause)
          ? clause.elements.map((element) => (element.propertyName ?? element.name).text)
          : ['*'];
      const typeOnly =
        node.isTypeOnly ||
        (clause !== undefined &&
          ts.isNamedExports(clause) &&
          clause.elements.length > 0 &&
          clause.elements.every((element) => element.isTypeOnly));
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
 * The bare package a specifier names: `@scope/name` or `name`.
 *
 * @param {string} specifier
 * @returns {string}
 */
function bareName(specifier) {
  return specifier.startsWith('@')
    ? specifier.split('/').slice(0, 2).join('/')
    : (specifier.split('/')[0] ?? specifier);
}

/**
 * Walks every engine package under `packagesDir` and returns every import that crosses a package
 * (from a source file or a manifest), every import of a banned package, and the relative imports
 * that name no file.
 *
 * @param {string} packagesDir
 * @returns {{ edges: Edge[], banned: BannedImport[], unresolved: string[] }}
 */
export function collectEdges(packagesDir) {
  const root = resolve(packagesDir);
  /** @type {Edge[]} */
  const edges = [];
  /** @type {BannedImport[]} */
  const banned = [];
  /** @type {string[]} */
  const unresolved = [];
  for (const [pkg, fromGroup] of Object.entries(PACKAGE_GROUPS)) {
    const pkgDir = join(root, pkg);
    const srcDir = join(pkgDir, 'src');
    if (!existsSync(srcDir)) {
      continue;
    }
    const manifestPath = join(pkgDir, 'package.json');
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      const listed = { ...manifest.dependencies, ...manifest.devDependencies, ...manifest.optionalDependencies };
      for (const name of Object.keys(listed)) {
        if (BANNED_PACKAGES.includes(name)) {
          banned.push({ from: `${pkg}/package.json`, specifier: name });
        }
        const toGroup = groupOfSpecifier(name);
        if (toGroup !== undefined && toGroup !== fromGroup) {
          edges.push({
            from: `${pkg}/package.json`,
            to: name,
            fromGroup,
            toGroup,
            names: ['(dependency)'],
            typeOnly: false,
            relative: false,
          });
        }
      }
    }
    for (const file of sourceFiles(srcDir)) {
      const from = `${pkg}/${relative(srcDir, file).split(sep).join('/')}`;
      for (const found of importsOf(file)) {
        if (found.specifier.startsWith('.')) {
          const target = resolveSpecifier(file, found.specifier);
          if (target === undefined) {
            unresolved.push(`${from} -> ${found.specifier}`);
            continue;
          }
          const inside = relative(srcDir, target);
          if (!inside.startsWith('..')) {
            continue;
          }
          const to = relative(root, target).split(sep).join('/');
          const toGroup = PACKAGE_GROUPS[to.split('/')[0] ?? ''] ?? 'outside';
          edges.push({ from, to, fromGroup, toGroup, names: found.names, typeOnly: found.typeOnly, relative: true });
          continue;
        }
        if (BANNED_PACKAGES.includes(bareName(found.specifier))) {
          banned.push({ from, specifier: found.specifier });
          continue;
        }
        const toGroup = groupOfSpecifier(found.specifier);
        if (toGroup !== undefined && toGroup !== fromGroup) {
          edges.push({
            from,
            to: found.specifier,
            fromGroup,
            toGroup,
            names: found.names,
            typeOnly: found.typeOnly,
            relative: false,
          });
        }
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
  if (edge.relative) {
    return 'a relative import never leaves its package';
  }
  if (edge.fromGroup === 'compose') {
    return undefined;
  }
  if (edge.toGroup === 'compose') {
    return 'rule 3: nothing imports compose';
  }
  if (edge.toGroup === 'core') {
    return undefined;
  }
  return edge.fromGroup === 'core' ? 'rule 2: core imports no protocol' : 'rule 1: no other protocol';
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
  const rootFlag = argv.indexOf('--root');
  const packagesDir =
    rootFlag === -1 ? fileURLToPath(new URL('../packages', import.meta.url)) : resolve(argv[rootFlag + 1] ?? '.');
  const { edges, banned, unresolved } = collectEdges(packagesDir);
  const violations = checkEdges(edges);

  if (argv.includes('--json')) {
    console.log(JSON.stringify({ edges, violations, banned, unresolved }, null, 2));
  } else if (argv.includes('--check')) {
    for (const edge of violations) {
      console.error(`${formatEdge(edge)}\n    breaks ${ruleBroken(edge) ?? ''} (package split spec §4)`);
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
        `${String(allowed)} allowed import(s) across packages`,
    );
  } else {
    for (const edge of edges) {
      console.log(formatEdge(edge));
    }
    console.log(`${String(edges.length)} cross-package import(s)`);
  }

  if (argv.includes('--check') && violations.length + banned.length + unresolved.length > 0) {
    process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2));
}
