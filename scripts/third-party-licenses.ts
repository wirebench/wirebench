/**
 * Regenerates `THIRD-PARTY-LICENSES.md`: every third-party package whose code ships inside a
 * Wirebench installer, with its version, declared license and the verbatim text of its own
 * LICENSE/NOTICE file.
 *
 * `node scripts/third-party-licenses.ts` writes the file; `--check` exits non-zero when the
 * committed file is out of date (this runs as part of `pnpm check`). The file is committed so
 * a reviewer can see attribution changes in a diff, and electron-builder copies it into every
 * installer's resources (`extraResources` in `apps/desktop/electron-builder.yml`).
 *
 * What counts as "ships":
 *   * `apps/desktop`'s `dependencies` and `packages/engine`'s `dependencies`, transitively —
 *     these are resolved at runtime from `node_modules` inside the asar.
 *   * {@link BUNDLED_DEV_DEPENDENCIES}, transitively. They sit in `devDependencies` because
 *     electron-vite bundles them rather than resolving them at runtime, but their code (React,
 *     Monaco, Radix, Tailwind's preflight CSS) is inside the shipped renderer bundle all the
 *     same, and Electron *is* the runtime — Chromium's and Node's notices arrive with it.
 *
 * Build-only tooling (vite, electron-builder, TypeScript, the test stack) is deliberately
 * absent: none of it is distributed.
 */

import { readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const target = join(repoRoot, 'THIRD-PARTY-LICENSES.md');

/**
 * Packages that are `devDependencies` by electron-vite convention but whose code (or runtime)
 * is distributed. Keep this list in sync with what the renderer bundle actually imports.
 */
const BUNDLED_DEV_DEPENDENCIES = [
  '@electron-toolkit/preload',
  '@monaco-editor/react',
  '@radix-ui/react-alert-dialog',
  '@radix-ui/react-context-menu',
  '@radix-ui/react-dialog',
  '@radix-ui/react-dropdown-menu',
  '@radix-ui/react-scroll-area',
  '@radix-ui/react-tabs',
  '@radix-ui/react-tooltip',
  '@tanstack/react-virtual',
  'cmdk',
  'electron',
  'immer',
  'lucide-react',
  'monaco-editor',
  'react',
  'react-arborist',
  'react-dom',
  'react-resizable-panels',
  'tailwindcss',
  'zustand',
] as const;

/** Workspace packages: Wirebench's own code, covered by the repository's own LICENSE. */
const OWN_PACKAGES = new Set(['@wirebench/engine', '@wirebench/desktop', '@wirebench/cli']);

/** File names that may carry a license or notice, in the order they are looked for. */
const LICENSE_FILE_PATTERN = /^(licen[cs]e|notice|copying)(\.(md|txt|markdown))?$/i;

interface PackageManifest {
  readonly name?: string;
  readonly version?: string;
  readonly license?: string | { readonly type?: string };
  readonly licenses?: readonly { readonly type?: string }[];
  readonly dependencies?: Readonly<Record<string, string>>;
}

/** One package as it appears in the generated file. */
interface LicensedPackage {
  readonly name: string;
  readonly version: string;
  readonly license: string;
  readonly noticeFile?: string;
  readonly notice?: string;
}

/**
 * Finds `name`'s directory the way Node resolves it from `fromDir`: walking up, looking for
 * `node_modules/<name>`. Real paths are used so pnpm's symlinked store resolves to the
 * directory whose *own* `node_modules` holds that package's dependencies.
 *
 * @param name the package to find
 * @param fromDir the directory to resolve from
 */
async function findPackageDir(name: string, fromDir: string): Promise<string | undefined> {
  let current = fromDir;
  for (;;) {
    const candidate = join(current, 'node_modules', name);
    const manifest = await readManifest(candidate);
    if (manifest !== undefined) {
      return realpath(candidate);
    }
    const parent = dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

/** Reads a package manifest, or `undefined` when there is none at `dir`. */
async function readManifest(dir: string): Promise<PackageManifest | undefined> {
  try {
    return JSON.parse(await readFile(join(dir, 'package.json'), 'utf-8')) as PackageManifest;
  } catch {
    return undefined;
  }
}

/** The declared license of a manifest, in SPDX form where the manifest gives one. */
function licenseOf(manifest: PackageManifest): string {
  if (typeof manifest.license === 'string') {
    return manifest.license;
  }
  if (typeof manifest.license?.type === 'string') {
    return manifest.license.type;
  }
  const legacy = manifest.licenses?.[0]?.type;
  return legacy ?? 'UNKNOWN';
}

/** The package's own LICENSE/NOTICE file, when it ships one. */
async function readNotice(dir: string): Promise<{ file: string; text: string } | undefined> {
  let entries: readonly string[];
  try {
    entries = await readdir(dir);
  } catch {
    return undefined;
  }
  const file = [...entries].sort().find((entry) => LICENSE_FILE_PATTERN.test(entry));
  if (file === undefined) {
    return undefined;
  }
  try {
    return { file, text: (await readFile(join(dir, file), 'utf-8')).replace(/\r\n/g, '\n').trimEnd() };
  } catch {
    return undefined;
  }
}

/** Walks the dependency graph from `roots`, collecting every distributed package exactly once. */
async function collect(roots: readonly { name: string; from: string }[]): Promise<readonly LicensedPackage[]> {
  const found = new Map<string, LicensedPackage>();
  const seen = new Set<string>();
  const queue = [...roots];

  while (queue.length > 0) {
    const job = queue.shift();
    /* c8 ignore next 3 -- queue.length > 0 guarantees a defined element */
    if (job === undefined) {
      continue;
    }
    const dir = await findPackageDir(job.name, job.from);
    if (dir === undefined) {
      throw new Error(`Cannot resolve "${job.name}" from ${job.from}; run \`pnpm install\` first`);
    }
    if (seen.has(dir)) {
      continue;
    }
    seen.add(dir);

    const manifest = await readManifest(dir);
    /* c8 ignore next 3 -- findPackageDir only returns a directory whose manifest parsed */
    if (manifest === undefined) {
      continue;
    }
    for (const dependency of Object.keys(manifest.dependencies ?? {})) {
      queue.push({ name: dependency, from: dir });
    }
    if (OWN_PACKAGES.has(job.name)) {
      continue;
    }

    const notice = await readNotice(dir);
    found.set(`${job.name}@${manifest.version ?? '0.0.0'}`, {
      name: job.name,
      version: manifest.version ?? '0.0.0',
      license: licenseOf(manifest),
      ...(notice !== undefined ? { noticeFile: notice.file, notice: notice.text } : {}),
    });
  }

  return [...found.values()].sort((a, b) =>
    a.name === b.name ? a.version.localeCompare(b.version) : a.name < b.name ? -1 : 1,
  );
}

/**
 * A fence long enough that nothing inside `text` closes it early — license files do sometimes
 * contain triple backticks.
 */
function fenceFor(text: string): string {
  let length = 3;
  for (const match of text.matchAll(/`{3,}/g)) {
    length = Math.max(length, match[0].length + 1);
  }
  return '`'.repeat(length);
}

/** Renders the whole document. */
function render(packages: readonly LicensedPackage[]): string {
  const lines: string[] = [
    '# Third-party licenses',
    '',
    'Wirebench itself is licensed under Apache-2.0 (see [`LICENSE`](LICENSE)). It is distributed',
    'with the third-party packages listed below, each under its own license. This file is',
    'generated by `node scripts/third-party-licenses.ts` and checked by `pnpm check`; it is',
    'copied into every installer as `THIRD-PARTY-LICENSES.md` in the application resources.',
    '',
    `${String(packages.length)} packages.`,
    '',
    '| Package | Version | License |',
    '| --- | --- | --- |',
  ];
  for (const entry of packages) {
    lines.push(`| \`${entry.name}\` | ${entry.version} | ${entry.license} |`);
  }
  lines.push('');
  for (const entry of packages) {
    lines.push(`## ${entry.name}@${entry.version}`, '', `License: ${entry.license}`, '');
    if (entry.notice === undefined) {
      lines.push(`This package ships no license file of its own; its manifest declares \`${entry.license}\`.`, '');
      continue;
    }
    const fence = fenceFor(entry.notice);
    lines.push(`From its \`${entry.noticeFile ?? 'LICENSE'}\`:`, '', fence, entry.notice, fence, '');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

/** Builds the document's current content from `node_modules`. */
export async function renderThirdPartyLicenses(): Promise<string> {
  const desktopDir = join(repoRoot, 'apps', 'desktop');
  const engineDir = join(repoRoot, 'packages', 'engine');
  const desktop = await readManifest(desktopDir);
  const engine = await readManifest(engineDir);
  if (desktop === undefined || engine === undefined) {
    throw new Error('Cannot read the workspace manifests');
  }
  const roots = [
    ...Object.keys(desktop.dependencies ?? {}).map((name) => ({ name, from: desktopDir })),
    ...Object.keys(engine.dependencies ?? {}).map((name) => ({ name, from: engineDir })),
    ...BUNDLED_DEV_DEPENDENCIES.map((name) => ({ name, from: desktopDir })),
  ];
  return render(await collect(roots));
}

async function main(): Promise<void> {
  const rendered = await renderThirdPartyLicenses();
  const check = process.argv.includes('--check');
  const current = await readFile(target, 'utf-8').catch(() => undefined);

  if (current === rendered) {
    process.stdout.write('THIRD-PARTY-LICENSES.md is up to date\n');
    return;
  }
  if (check) {
    process.stderr.write('THIRD-PARTY-LICENSES.md is out of date; run `pnpm licenses:third-party`\n');
    process.exitCode = 1;
    return;
  }
  await writeFile(target, rendered, 'utf-8');
  process.stdout.write(`Wrote ${target}\n`);
}

// Importable from the test that guards the committed file; only the CLI run writes anything.
const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  await main();
}
