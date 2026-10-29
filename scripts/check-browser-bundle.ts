/**
 * Asserts that the browser client's build (`apps/desktop/dist-browser`, hosted edition spec §17.6) is a
 * page a browser can load: an `index.html`, hashed asset names, and no import of `electron` or a `node:`
 * built-in anywhere in its scripts, and no module Vite stubbed out as browser-external; either would fail
 * in a tab. Run by `build:browser` after
 * the Vite build, so `pnpm check` never needs that build.
 *
 *   node scripts/check-browser-bundle.ts <dist-browser dir>
 */

import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * A static or dynamic import, or a `require`, of `electron` (or a subpath) or of a `node:` module, in
 * minified spelling too (`from"electron"`, `import"electron";`).
 */
const FORBIDDEN_IMPORT =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*|\brequire\s*\(\s*)(["'`])(electron(?:\/[^"'`]*)?|node:[^"'`]+)\1/g;

/**
 * What Vite puts in place of a Node built-in it cannot bundle for a browser: the build then "works" and
 * the page fails when the code runs. `vite.browser.config.ts` already turns the warning into an error.
 */
const BROWSER_EXTERNAL = '__vite-browser-external';

/** `name-<hash>.ext`, as Vite writes it: an 8-character base64url hash. */
const HASHED_NAME = /-[A-Za-z0-9_-]{8}\.[a-z0-9]+$/;

/** Every forbidden module a script's text imports. */
export function forbiddenImports(text: string): string[] {
  return [...text.matchAll(FORBIDDEN_IMPORT)].map((match) => match[2] ?? '');
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? filesUnder(join(dir, entry.name)) : [join(dir, entry.name)],
  );
}

export function checkBrowserBundle(dir: string): string[] {
  if (!existsSync(join(dir, 'index.html'))) return [`${join(dir, 'index.html')} is missing`];
  const problems: string[] = [];
  const assets = join(dir, 'assets');
  const files = existsSync(assets) ? filesUnder(assets) : [];
  if (!files.some((file) => file.endsWith('.js'))) problems.push(`${assets} holds no script`);
  for (const file of files) {
    const name = relative(dir, file);
    if (!HASHED_NAME.test(file)) problems.push(`${name} has no content hash in its name`);
    if (!/\.(?:m?js|html)$/.test(file)) continue;
    const text = readFileSync(file, 'utf8');
    if (text.includes(BROWSER_EXTERNAL)) {
      problems.push(`${name} holds ${BROWSER_EXTERNAL}: a Node module was stubbed out for the browser`);
    }
    for (const module of forbiddenImports(text)) {
      problems.push(`${name} imports ${module}, which a browser cannot load`);
    }
  }
  for (const module of forbiddenImports(readFileSync(join(dir, 'index.html'), 'utf8'))) {
    problems.push(`index.html imports ${module}, which a browser cannot load`);
  }
  return problems;
}

if (process.argv[1] !== undefined && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
  const dir = process.argv[2];
  if (dir === undefined) {
    console.error('usage: node scripts/check-browser-bundle.ts <dist-browser dir>');
    process.exit(2);
  }
  const problems = checkBrowserBundle(dir);
  for (const problem of problems) console.error(`browser bundle: ${problem}`);
  if (problems.length > 0) process.exit(1);
  console.log(`browser bundle: ${dir} is a page with hashed assets and no electron or node: import`);
}
