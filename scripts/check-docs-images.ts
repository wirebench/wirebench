/**
 * Keeps the docs site's images and its pages in step: every image a page cites must exist under
 * `docs-site/public/images/`, and every image there must be cited by at least one page. The first
 * catches a page written before its screenshot was shot; the second, a screenshot left behind
 * after the page stopped using it.
 *
 * A citation is any `/wirebench/images/<path>` in a page — a Markdown image or an HTML `src`.
 * `node scripts/check-docs-images.ts` prints the result and exits non-zero on any problem. Wired
 * into `pnpm check` as `pnpm check:docs-images`.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Where the site keeps its pages and its images, relative to the repo root. */
const CONTENT_DIR = 'docs-site/src/content/docs';
const IMAGES_DIR = 'docs-site/public/images';

/** The image files the check knows about; anything else in the folder is not its business. */
const IMAGE_EXTENSION = /\.(png|jpe?g|svg|webp|gif)$/;

/** Every image path (relative to the images folder) that `page` cites. Pure. */
export function citedImages(page: string): string[] {
  return [...page.matchAll(/\/wirebench\/images\/([^\s)"'#?]+)/g)].map((match) => match[1]!);
}

/** The problems between what pages cite and what the images folder holds. Pure. */
export function compareImages(
  cited: readonly string[],
  present: readonly string[],
): { readonly missing: string[]; readonly orphaned: string[] } {
  const citedSet = new Set(cited);
  const presentSet = new Set(present);
  return {
    missing: [...citedSet].filter((image) => !presentSet.has(image)).sort(),
    orphaned: [...presentSet].filter((image) => !citedSet.has(image)).sort(),
  };
}

/** Files under `dir` (recursively) matching `pattern`, relative to `dir` with `/` separators. */
async function filesUnder(dir: string, pattern: RegExp): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true }).catch(() => [] as string[]);
  return entries.filter((file) => pattern.test(file)).map((file) => file.split('\\').join('/'));
}

async function main(): Promise<void> {
  const repoRoot = fileURLToPath(new URL('..', import.meta.url));
  const pages = await filesUnder(join(repoRoot, CONTENT_DIR), /\.mdx?$/);
  const cited: string[] = [];
  for (const page of pages) {
    cited.push(...citedImages(await readFile(join(repoRoot, CONTENT_DIR, page), 'utf-8')));
  }
  const present = await filesUnder(join(repoRoot, IMAGES_DIR), IMAGE_EXTENSION);
  const { missing, orphaned } = compareImages(cited, present);

  if (missing.length === 0 && orphaned.length === 0) {
    process.stdout.write(`docs-site images: all ${String(present.length)} cited, none missing\n`);
    return;
  }
  const lines = [
    ...missing.map((image) => `  - missing: ${IMAGES_DIR}/${image} (cited by a page, not on disk)`),
    ...orphaned.map((image) => `  - orphaned: ${IMAGES_DIR}/${image} (on disk, cited by no page)`),
  ];
  process.stderr.write(`docs-site images are out of step with the pages:\n${lines.join('\n')}\n`);
  process.exitCode = 1;
}

// Only run when executed directly, not when the test file imports the pure functions above.
if (process.argv[1] !== undefined && import.meta.url === new URL(process.argv[1], 'file:').href) {
  await main();
}
