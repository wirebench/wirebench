/**
 * Keeps each site's images and its pages in step: every image a page cites must exist under the
 * site's images folder, and every image there must be cited by at least one page. The first catches
 * a page written before its screenshot was shot; the second, a screenshot left behind after the
 * page stopped using it.
 *
 * Two sites are checked. The user guide (`docs-site/`) cites images in its Markdown pages as
 * `/wirebench/docs/images/<path>` against `docs-site/public/images/`; the landing site (`site/`)
 * cites them in its `.astro` pages as `/wirebench/images/<path>` against `site/public/images/`. A
 * citation is any such path in a page — a Markdown image or an HTML `src`.
 * `node scripts/check-docs-images.ts` prints the result per site and exits non-zero on any problem.
 * Wired into `pnpm check` as `pnpm check:docs-images`.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** One site the check covers; every path is relative to the repo root. */
interface Site {
  readonly name: string;
  /** Where its pages live, and which files there are pages. */
  readonly contentDir: string;
  readonly pagePattern: RegExp;
  /** Where its images live, and the URL prefix a page cites them by. */
  readonly imagesDir: string;
  readonly prefix: string;
}

export const SITES: readonly Site[] = [
  {
    name: 'docs-site',
    contentDir: 'docs-site/src/content/docs',
    pagePattern: /\.mdx?$/,
    imagesDir: 'docs-site/public/images',
    prefix: '/wirebench/docs/images/',
  },
  {
    name: 'site',
    contentDir: 'site/src',
    pagePattern: /\.astro$/,
    imagesDir: 'site/public/images',
    prefix: '/wirebench/images/',
  },
];

/** The image files the check knows about; anything else in the folder is not its business. */
const IMAGE_EXTENSION = /\.(png|jpe?g|svg|webp|gif)$/;

/** `text` with every regular-expression metacharacter escaped, so it matches literally. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Every image path (relative to the images folder) that `page` cites under `prefix`. Pure. */
export function citedImages(page: string, prefix: string): string[] {
  const citation = new RegExp(`${escapeRegExp(prefix)}([^\\s)"'#?]+)`, 'g');
  return [...page.matchAll(citation)].map((match) => match[1]!);
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

/** Checks one site; returns whether its images and pages are in step. */
async function checkSite(repoRoot: string, site: Site): Promise<boolean> {
  const pages = await filesUnder(join(repoRoot, site.contentDir), site.pagePattern);
  const cited: string[] = [];
  for (const page of pages) {
    cited.push(...citedImages(await readFile(join(repoRoot, site.contentDir, page), 'utf-8'), site.prefix));
  }
  const present = await filesUnder(join(repoRoot, site.imagesDir), IMAGE_EXTENSION);
  const { missing, orphaned } = compareImages(cited, present);

  if (missing.length === 0 && orphaned.length === 0) {
    process.stdout.write(`${site.name} images: all ${String(present.length)} cited, none missing\n`);
    return true;
  }
  const lines = [
    ...missing.map((image) => `  - missing: ${site.imagesDir}/${image} (cited by a page, not on disk)`),
    ...orphaned.map((image) => `  - orphaned: ${site.imagesDir}/${image} (on disk, cited by no page)`),
  ];
  process.stderr.write(`${site.name} images are out of step with the pages:\n${lines.join('\n')}\n`);
  return false;
}

async function main(): Promise<void> {
  const repoRoot = fileURLToPath(new URL('..', import.meta.url));
  let ok = true;
  for (const site of SITES) {
    ok = (await checkSite(repoRoot, site)) && ok;
  }
  if (!ok) process.exitCode = 1;
}

// Only run when executed directly, not when the test file imports the pure functions above.
if (process.argv[1] !== undefined && import.meta.url === new URL(process.argv[1], 'file:').href) {
  await main();
}
