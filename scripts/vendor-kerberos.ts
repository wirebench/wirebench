/**
 * Vendors the Kerberos binding for every architecture of one platform into
 * apps/desktop/build-resources/kerberos/<platform>-<arch>/kerberos.node (ADR-0019).
 *
 * The release jobs pack several architectures from one install with npmRebuild off, so the
 * installed binary only matches the runner; this downloads the pinned prebuilds instead and refuses
 * any whose SHA-256 differs from scripts/kerberos-prebuilds.json.
 *
 *   node scripts/vendor-kerberos.ts [darwin|linux|win32]
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readTarGz } from './lib/tar.ts';

interface PinFile {
  readonly version: string;
  readonly napi: number;
  readonly url: string;
  readonly entry: string;
  readonly prebuilds: Readonly<Record<string, string>>;
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PIN_FILE = join(ROOT, 'scripts', 'kerberos-prebuilds.json');
export const DEFAULT_OUT_DIR = join(ROOT, 'apps', 'desktop', 'build-resources', 'kerberos');

export async function vendorKerberos(options: {
  readonly platform: 'darwin' | 'linux' | 'win32';
  readonly outDir: string;
  readonly pins?: Readonly<Record<string, string>>;
  readonly fetchBytes?: (url: string) => Promise<Buffer>;
}): Promise<string[]> {
  const file = JSON.parse(await readFile(PIN_FILE, 'utf8')) as PinFile;
  const pins = options.pins ?? file.prebuilds;
  const fetchBytes = options.fetchBytes ?? download;
  const extracted: (readonly [string, Uint8Array])[] = [];
  for (const prebuild of Object.keys(pins).filter((name) => name.startsWith(`${options.platform}-`))) {
    const url = file.url
      .replaceAll('{version}', file.version)
      .replace('{napi}', String(file.napi))
      .replace('{prebuild}', prebuild);
    const bytes = await fetchBytes(url);
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (actual !== pins[prebuild]) {
      throw new Error(`SHA-256 mismatch for ${prebuild}: expected ${pins[prebuild]}, got ${actual} (${url})`);
    }
    const entry = readTarGz(new Uint8Array(bytes)).find((candidate) => candidate.name === file.entry);
    if (entry === undefined) throw new Error(`${prebuild}: ${file.entry} is not in the tarball`);
    extracted.push([prebuild, entry.bytes]);
  }
  // Everything is verified before anything is written: a mismatch leaves the previous folder as it was.
  await rm(options.outDir, { recursive: true, force: true });
  const written: string[] = [];
  for (const [prebuild, data] of extracted) {
    const target = join(options.outDir, prebuild, 'kerberos.node');
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, data);
    written.push(target);
  }
  return written;
}

async function download(url: string): Promise<Buffer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120_000);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { 'user-agent': 'wirebench-build' } });
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
    return Buffer.from(await response.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

/** A ustar header plus padded body for one regular file: the test's fixture tarballs. */
export function tarEntry(name: string, data: Buffer): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, 'utf8');
  header.write('0000644\0', 100);
  header.write('0000000\0', 108);
  header.write('0000000\0', 116);
  header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124);
  header.write('00000000000\0', 136);
  header.write('        ', 148);
  header.write('0', 156);
  header.write('ustar\u000000', 257);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  return Buffer.concat([header, data, Buffer.alloc((512 - (data.length % 512)) % 512)]);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const platform = (process.argv[2] ?? process.platform) as 'darwin' | 'linux' | 'win32';
  const written = await vendorKerberos({ platform, outDir: DEFAULT_OUT_DIR });
  console.log(`kerberos: vendored ${written.length} binding(s) for ${platform}`);
}
