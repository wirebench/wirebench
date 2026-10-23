/**
 * The API report for `@wirebench/engine/plugin` (phase 7 spec §5): the subpath's emitted declarations,
 * committed as `packages/engine/api/plugin.api.md` (a TypeScript block in Markdown, so lint
 * and formatting leave it alone), so a change to what plugin authors build against
 * is a reviewed diff with a version bump.
 *
 * `node scripts/plugin-api-report.ts` writes the report; `--check` (in `pnpm check`) exits non-zero
 * when the committed report is out of date. Either refuses when the surface changed but
 * `PLUGIN_API_VERSION` did not, and when the subpath imports anything: it must stay self-contained.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { format, resolveConfig } from 'prettier';
import ts from 'typescript';

const SOURCE = fileURLToPath(new URL('../packages/engine/src/plugin.ts', import.meta.url));
const REPORT = fileURLToPath(new URL('../packages/engine/api/plugin.api.md', import.meta.url));

const HEADER =
  '# `@wirebench/engine/plugin` API report\n\nWritten by `pnpm plugin-api:report`, checked by `pnpm check:plugin-api`. A change here needs a\n`PLUGIN_API_VERSION` bump: minor to add, major to break.\n\n';
const VERSION_LINE = /^PLUGIN_API_VERSION: (\S+)\n/m;

/** The version `source` declares. @throws when it declares none */
export function declaredVersion(source: string): string {
  const match = /export const PLUGIN_API_VERSION = '(\d+\.\d+\.\d+)';/.exec(source);
  if (match?.[1] === undefined) throw new Error('plugin.ts declares no PLUGIN_API_VERSION');
  return match[1];
}

/** Each module the source reaches: an import, a re-export, a dynamic `import()` or `require`. */
export function moduleReferences(source: string): readonly string[] {
  const file = ts.createSourceFile('plugin.ts', source, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      found.push(node.moduleSpecifier.text);
    } else if (ts.isImportEqualsDeclaration(node) || ts.isImportTypeNode(node)) {
      found.push(node.getText(file));
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
    ) {
      found.push(node.getText(file));
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

/** The report for `source`: its declarations under a header naming its version, as prettier lays them out. */
export async function renderReport(source: string): Promise<string> {
  const { outputText, diagnostics } = ts.transpileDeclaration(source, {
    fileName: 'plugin.ts',
    compilerOptions: { removeComments: true },
    reportDiagnostics: true,
  });
  if (diagnostics !== undefined && diagnostics.length > 0) {
    const messages = diagnostics.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
    throw new Error(`plugin.ts does not emit declarations on its own:\n${messages.join('\n')}`);
  }
  const markdown = `${HEADER}PLUGIN_API_VERSION: ${declaredVersion(source)}\n\n\`\`\`ts\n${outputText.replaceAll('\r\n', '\n')}\`\`\`\n`;
  const options = (await resolveConfig(REPORT)) ?? {};
  return format(markdown, { ...options, parser: 'markdown' });
}

const bodyOf = (report: string): string => report.replace(HEADER, '').replace(VERSION_LINE, '');

/**
 * What is wrong with `committed` against the report `source` makes now, or undefined when nothing is.
 * A changed surface under an unchanged version is the one problem regenerating does not fix.
 */
export async function reportProblem(source: string, committed: string | undefined): Promise<string | undefined> {
  const references = moduleReferences(source);
  if (references.length > 0) {
    return `packages/engine/src/plugin.ts must import nothing; it reaches ${references.join(', ')}`;
  }
  const fresh = await renderReport(source);
  if (committed === fresh) return undefined;
  if (committed === undefined) return 'packages/engine/api/plugin.api.md is missing: run `pnpm plugin-api:report`';
  const committedVersion = VERSION_LINE.exec(committed)?.[1];
  if (bodyOf(committed) !== bodyOf(fresh) && committedVersion === declaredVersion(source)) {
    return `the plugin API changed but PLUGIN_API_VERSION is still ${committedVersion}: bump it in packages/engine/src/plugin.ts (minor to add, major to break), then run \`pnpm plugin-api:report\``;
  }
  return 'packages/engine/api/plugin.api.md is out of date: run `pnpm plugin-api:report`';
}

async function main(check: boolean): Promise<number> {
  const source = await readFile(SOURCE, 'utf8');
  const committed = await readFile(REPORT, 'utf8').catch(() => undefined);
  const problem = await reportProblem(source, committed);
  if (problem === undefined) {
    process.stdout.write('plugin API report: up to date\n');
    return 0;
  }
  if (check || problem.includes('import nothing') || problem.includes('PLUGIN_API_VERSION is still')) {
    process.stderr.write(`plugin API report: ${problem}\n`);
    return 1;
  }
  await writeFile(REPORT, await renderReport(source));
  process.stdout.write('plugin API report: written\n');
  return 0;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main(process.argv.includes('--check'));
}
