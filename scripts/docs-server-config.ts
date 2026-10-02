/**
 * Regenerates the configuration table in `packages/server/README.md` and in the user guide's
 * Wirebench Server page from `CONFIG_VARIABLES`, so the documented variables can never drift from the
 * schema. `--check` exits non-zero when either is stale (part of `pnpm check`).
 */
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { CONFIG_VARIABLES } from '../packages/server/src/config.ts';

/** The markers the table sits between. MDX has no HTML comments, so a `.mdx` page uses its own. */
export interface Markers {
  readonly start: string;
  readonly end: string;
}

const HTML_MARKERS: Markers = { start: '<!-- config:start -->', end: '<!-- config:end -->' };
const MDX_MARKERS: Markers = { start: '{/* config:start */}', end: '{/* config:end */}' };

/** Every file that carries the table, relative to the repository root. */
export const TARGETS: readonly { readonly path: string; readonly markers: Markers }[] = [
  { path: 'packages/server/README.md', markers: HTML_MARKERS },
  { path: 'docs-site/src/content/docs/guides/wirebench-server.mdx', markers: MDX_MARKERS },
];

export function renderConfigTable(): string {
  const lines = ['| Variable | Required | Default | Meaning |', '| --- | --- | --- | --- |'];
  for (const variable of CONFIG_VARIABLES) {
    const fallback = variable.defaultText !== undefined ? `\`${variable.defaultText}\`` : '—';
    lines.push(
      `| \`${variable.env}\` | ${variable.required ? 'yes' : 'no'} | ${fallback} | ${variable.description}${variable.secret ? ' Never logged.' : ''} |`,
    );
  }
  return lines.join('\n');
}

export function splice(document: string, table: string, markers: Markers = HTML_MARKERS): string {
  const start = document.indexOf(markers.start);
  const end = document.indexOf(markers.end);
  if (start < 0 || end < 0) {
    throw new Error(`document is missing ${markers.start} / ${markers.end}`);
  }
  return `${document.slice(0, start + markers.start.length)}\n${table}\n${document.slice(end)}`;
}

async function main(): Promise<void> {
  const table = renderConfigTable();
  const check = process.argv.includes('--check');
  for (const { path: relative, markers } of TARGETS) {
    const target = fileURLToPath(new URL(`../${relative}`, import.meta.url));
    const current = await readFile(target, 'utf-8');
    const rendered = splice(current, table, markers);
    if (current === rendered) {
      process.stdout.write(`${relative} config table is up to date\n`);
    } else if (check) {
      process.stderr.write(`${relative} config table is out of date; run \`pnpm docs:server-config\`\n`);
      process.exitCode = 1;
    } else {
      await writeFile(target, rendered, 'utf-8');
      process.stdout.write(`Wrote ${target}\n`);
    }
  }
}

if (process.argv[1] !== undefined && import.meta.url === new URL(process.argv[1], 'file:').href) {
  await main();
}
