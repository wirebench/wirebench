/**
 * Regenerates the configuration table in `packages/server/README.md` from `CONFIG_VARIABLES`, so the
 * documented variables can never drift from the schema. `--check` exits non-zero when it is stale
 * (part of `pnpm check`).
 */
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { CONFIG_VARIABLES } from '../packages/server/src/config.ts';

const target = fileURLToPath(new URL('../packages/server/README.md', import.meta.url));
const START = '<!-- config:start -->';
const END = '<!-- config:end -->';

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

export function splice(readme: string, table: string): string {
  const start = readme.indexOf(START);
  const end = readme.indexOf(END);
  if (start < 0 || end < 0) {
    throw new Error(`README is missing ${START} / ${END}`);
  }
  return `${readme.slice(0, start + START.length)}\n${table}\n${readme.slice(end)}`;
}

async function main(): Promise<void> {
  const current = await readFile(target, 'utf-8');
  const rendered = splice(current, renderConfigTable());
  if (current === rendered) {
    process.stdout.write('packages/server/README.md config table is up to date\n');
    return;
  }
  if (process.argv.includes('--check')) {
    process.stderr.write('packages/server/README.md config table is out of date; run `pnpm docs:server-config`\n');
    process.exitCode = 1;
    return;
  }
  await writeFile(target, rendered, 'utf-8');
  process.stdout.write(`Wrote ${target}\n`);
}

if (process.argv[1] !== undefined && import.meta.url === new URL(process.argv[1], 'file:').href) {
  await main();
}
