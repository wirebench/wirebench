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
import { realpathSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
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
  const prebuilds = Object.keys(pins).filter((name) => name.startsWith(`${options.platform}-`));
  if (prebuilds.length === 0) throw new Error(`No pinned Kerberos prebuilds for platform ${options.platform}.`);
  for (const prebuild of prebuilds) {
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

/** Waits before the 2nd and 3rd attempt of a download. */
const RETRY_DELAYS_MS: readonly number[] = [1000, 3000];

/** A download that must not be retried: the server answered and the answer will not change. */
class PermanentDownloadError extends Error {}

/**
 * Fetches `url` with up to three attempts. Network errors, timeouts, HTTP 5xx and 429 are retried
 * after the given delays; any other HTTP failure is final. The hash check is the caller's job.
 */
export async function download(
  url: string,
  options: { readonly fetchFn?: typeof fetch; readonly delaysMs?: readonly number[] } = {},
): Promise<Buffer> {
  const fetchFn = options.fetchFn ?? fetch;
  const delays = options.delaysMs ?? RETRY_DELAYS_MS;
  for (let attempt = 0; ; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120_000);
    try {
      const response = await fetchFn(url, { signal: controller.signal, headers: { 'user-agent': 'wirebench-build' } });
      if (response.ok) return Buffer.from(await response.arrayBuffer());
      const message = `HTTP ${String(response.status)} for ${url}`;
      if (response.status >= 500 || response.status === 429) throw new Error(message);
      throw new PermanentDownloadError(message);
    } catch (error) {
      const delay = delays[attempt];
      if (error instanceof PermanentDownloadError || delay === undefined) throw error;
      await new Promise((resolve) => setTimeout(resolve, delay));
    } finally {
      clearTimeout(timer);
    }
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

if (process.argv[1] !== undefined && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
  const requested = process.argv[2] ?? process.platform;
  if (requested !== 'darwin' && requested !== 'linux' && requested !== 'win32') {
    console.error(`kerberos: unsupported platform "${requested}"; use darwin, linux or win32.`);
    process.exit(1);
  }
  const platform = requested;
  const written = await vendorKerberos({ platform, outDir: DEFAULT_OUT_DIR });
  console.log(`kerberos: vendored ${written.length} binding(s) for ${platform}`);
}
