/**
 * Writes the published JSON Schemas of a project folder (#66) from the engine's
 * `projectJsonSchemas()`, which converts the Zod schemas the loader parses with, so the published
 * schemas can never drift from what a build reads.
 *
 * The schemas go to `docs-site/public/schemas/v<formatVersion>/`, which the documentation site
 * serves at each schema's `$id`; the folders of earlier format versions stay as they were, so a URL
 * a project already points at keeps working. The release attaches the folder to each GitHub release.
 * The editor settings in the project-format reference page, between its `schemas:` markers, are
 * written from the same list.
 *
 * `node scripts/project-schemas.ts` writes both; `--check` exits non-zero when either is stale (part
 * of `pnpm check`). The engine is read from its build output: run `pnpm build` (or `pnpm typecheck`,
 * which emits it) first.
 */
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { format, resolveConfig } from 'prettier';
import type { ProjectJsonSchema } from '../packages/engine/src/project-files.ts';
import { splice } from './docs-server-config.ts';

/** Where the schemas are written, relative to the repository root. */
export const SCHEMAS_DIR = 'docs-site/public/schemas';
/** The page that carries the editor settings. */
export const PAGE = 'docs-site/src/content/docs/reference/project-format.md';
export const MARKERS = { start: '<!-- schemas:start -->', end: '<!-- schemas:end -->' } as const;

const fromRoot = (relative: string): string => fileURLToPath(new URL(`../${relative}`, import.meta.url));

/**
 * The `yaml.schemas` setting that maps each kind's files to its schema, as the Markdown code block
 * the page shows. A glob is prefixed with `**` so it matches wherever the project folder sits.
 */
export function renderEditorSettings(schemas: readonly ProjectJsonSchema[]): string {
  const mapping = Object.fromEntries(
    schemas.map(({ kind, schema }) => [
      String(schema['$id']),
      kind.files.map((glob) => (glob.startsWith('**/') ? glob : `**/${glob}`)),
    ]),
  );
  return ['```json', JSON.stringify({ 'yaml.schemas': mapping }, null, 2), '```'].join('\n');
}

/** Each schema file's text, by its path relative to the repository root, formatted as Prettier would. */
export async function renderSchemaFiles(schemas: readonly ProjectJsonSchema[]): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  for (const { path, schema } of schemas) {
    const relative = `${SCHEMAS_DIR}/${path}`;
    const filepath = fromRoot(relative);
    files.set(relative, await format(JSON.stringify(schema), { ...(await resolveConfig(filepath)), filepath }));
  }
  return files;
}

async function main(): Promise<void> {
  // Imported here, not at the top: a test that imports the renderers needs no build.
  const { projectJsonSchemas } = await import('../packages/engine/dist/index.js');
  const schemas = projectJsonSchemas();
  const check = process.argv.includes('--check');
  const stale: string[] = [];

  const files = await renderSchemaFiles(schemas);
  // Only the current version's folder is this build's: a file in it that no kind writes is stale too.
  const folders = new Set([...files.keys()].map((file) => dirname(file)));
  for (const folder of folders) {
    const present = await readdir(fromRoot(folder)).catch(() => [] as string[]);
    for (const name of present) {
      if (!files.has(`${folder}/${name}`)) stale.push(`${folder}/${name} (no kind writes it; delete it)`);
    }
  }
  for (const [relative, text] of files) {
    const current = await readFile(fromRoot(relative), 'utf-8').catch(() => undefined);
    if (current === text) continue;
    if (check) {
      stale.push(relative);
    } else {
      await mkdir(dirname(fromRoot(relative)), { recursive: true });
      await writeFile(fromRoot(relative), text, 'utf-8');
      process.stdout.write(`Wrote ${relative}\n`);
    }
  }

  const page = await readFile(fromRoot(PAGE), 'utf-8');
  const rendered = splice(page, renderEditorSettings(schemas), MARKERS);
  if (rendered !== page) {
    if (check) {
      stale.push(PAGE);
    } else {
      await writeFile(fromRoot(PAGE), rendered, 'utf-8');
      process.stdout.write(`Wrote ${PAGE}\n`);
    }
  }

  if (stale.length > 0) {
    process.stderr.write(
      `The project schemas are out of date; run \`pnpm schemas:project\`:\n${stale.map((s) => `  ${s}\n`).join('')}`,
    );
    process.exitCode = 1;
  } else if (check) {
    process.stdout.write(`${files.size} project schemas and ${PAGE} are up to date\n`);
  }
}

if (process.argv[1] !== undefined && import.meta.url === new URL(process.argv[1], 'file:').href) {
  await main();
}
