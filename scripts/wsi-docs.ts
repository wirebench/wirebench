/**
 * Regenerates `docs/ws-i-assertions.md` from the engine's WS-I assertion registry.
 *
 * `node scripts/wsi-docs.ts` writes the file; `node scripts/wsi-docs.ts --check` exits non-zero
 * when the committed file is out of date (this runs as part of `pnpm check`). The engine is read
 * from its build output, so run `pnpm build` (or `pnpm typecheck`, which emits it) first.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { renderWsiAssertionsMarkdown } from '../packages/engine/dist/index.js';

const target = fileURLToPath(new URL('../docs/ws-i-assertions.md', import.meta.url));

async function main(): Promise<void> {
  const rendered = renderWsiAssertionsMarkdown();
  const check = process.argv.includes('--check');
  const current = await readFile(target, 'utf-8').catch(() => undefined);

  if (current === rendered) {
    process.stdout.write(`docs/ws-i-assertions.md is up to date\n`);
    return;
  }
  if (check) {
    process.stderr.write('docs/ws-i-assertions.md is out of date; run `pnpm wsi:docs`\n');
    process.exitCode = 1;
    return;
  }
  await writeFile(target, rendered, 'utf-8');
  process.stdout.write(`Wrote ${target}\n`);
}

await main();
