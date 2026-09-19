/**
 * Brings an electron-builder update manifest (`latest.yml`) back in line with the installers beside
 * it, after they have been signed.
 *
 * electron-builder writes each installer's `sha512` and `size` into `latest.yml` when it builds the
 * installer. Signing afterwards rewrites the installer's bytes, so the manifest would describe a file
 * that no longer exists, and electron-updater rejects a download whose hash does not match. This
 * recomputes both fields for every `url` entry and for the top-level `path`, and changes nothing else.
 *
 * `node scripts/update-metadata.ts <dir>` rewrites `<dir>/latest.yml`; with `--check` it exits
 * non-zero when the manifest disagrees with the files instead. `--add <file>` (repeatable) first
 * lists another installer in `<dir>`: each Windows architecture is packaged in its own run, from its
 * own signed app, and each run writes a manifest naming only itself. Line-based on purpose: the manifest's
 * shape is fixed by electron-builder, and a YAML round-trip would reformat the rest of it.
 */
import { createHash } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** What {@link updateManifest} needs to know about one file the manifest names. */
export interface FileFacts {
  readonly sha512: string;
  readonly size: number;
}

/**
 * `manifest` with every `sha512` and `size` replaced by the facts `facts` gives for the file they
 * belong to: the `url` of their list entry, or `path` for the top-level pair.
 */
export function updateManifest(manifest: string, facts: (file: string) => FileFacts): string {
  const lines = manifest.split('\n');
  let current: string | undefined;
  return lines
    .map((line) => {
      const url = /^\s*-\s+url:\s*(.+?)\s*$/.exec(line);
      if (url !== null) {
        current = unquote(url[1] as string);
        return line;
      }
      const path = /^path:\s*(.+?)\s*$/.exec(line);
      if (path !== null) {
        current = unquote(path[1] as string);
        return line;
      }
      const field = /^(\s*)(sha512|size):\s*.*$/.exec(line);
      if (field !== null && current !== undefined) {
        const [, indent, key] = field;
        const value = facts(current)[key as 'sha512' | 'size'];
        return `${indent as string}${key as string}: ${String(value)}`;
      }
      // A top-level key other than `path` ends the block the last `path` opened.
      if (/^\S/.test(line) && !line.startsWith('files:')) {
        current = undefined;
      }
      return line;
    })
    .join('\n');
}

function unquote(value: string): string {
  return value.replace(/^(['"])(.*)\1$/, '$2');
}

/** `manifest` with a `files` entry for each of `names` it does not list yet, after the last one. */
export function addFiles(manifest: string, names: readonly string[]): string {
  const lines = manifest.split('\n');
  const listed = new Set(
    lines.flatMap((line) => {
      const url = /^\s*-\s+url:\s*(.+?)\s*$/.exec(line);
      return url === null ? [] : [unquote(url[1] as string)];
    }),
  );
  const fresh = names.filter((name) => !listed.has(name));
  if (fresh.length === 0) {
    return manifest;
  }
  // The `files` list ends at the first top-level key after `files:`.
  const start = lines.findIndex((line) => line === 'files:');
  if (start === -1) {
    throw new Error('latest.yml has no files list');
  }
  let end = start + 1;
  while (end < lines.length && /^\s/.test(lines[end] as string)) {
    end += 1;
  }
  // Placeholders: `updateManifest` fills in the real values right after.
  const entries = fresh.flatMap((name) => [`  - url: ${name}`, '    sha512: -', '    size: 0']);
  return [...lines.slice(0, end), ...entries, ...lines.slice(end)].join('\n');
}

/** The sha512 (base64, as electron-builder writes it) and byte size of `file`. */
async function factsOf(file: string): Promise<FileFacts> {
  const [bytes, info] = await Promise.all([readFile(file), stat(file)]);
  return { sha512: createHash('sha512').update(bytes).digest('base64'), size: info.size };
}

async function main(): Promise<void> {
  const dir = process.argv.slice(2).find((arg, index, args) => !arg.startsWith('--') && args[index - 1] !== '--add');
  if (dir === undefined) {
    process.stderr.write('usage: node scripts/update-metadata.ts <dir> [--add <file>]... [--check]\n');
    process.exitCode = 2;
    return;
  }
  const target = join(dir, 'latest.yml');
  const added = process.argv.flatMap((arg, index) => (process.argv[index - 1] === '--add' ? [arg] : []));
  const original = await readFile(target, 'utf-8');
  const manifest = addFiles(original, added);
  const names = new Set<string>();
  updateManifest(manifest, (file) => {
    names.add(file);
    return { sha512: '', size: 0 };
  });
  const known = new Map<string, FileFacts>();
  for (const name of names) {
    known.set(name, await factsOf(join(dir, name)));
  }
  const updated = updateManifest(manifest, (file) => known.get(file) as FileFacts);

  if (updated === original) {
    process.stdout.write(`${target} matches its files\n`);
    return;
  }
  if (process.argv.includes('--check')) {
    process.stderr.write(`${target} does not match its files; run node scripts/update-metadata.ts ${dir}\n`);
    process.exitCode = 1;
    return;
  }
  await writeFile(target, updated, 'utf-8');
  process.stdout.write(`Wrote ${target}\n`);
}

if (process.argv[1] !== undefined && import.meta.url === new URL(process.argv[1], 'file:').href) {
  await main();
}
