/**
 * Downloads the public WSDL fixture set used by parser tests (Task 5+).
 *
 * For each service in {@link SERVICES}, fetches the WSDL, recursively downloads any
 * `wsdl:import`/`xs:import`/`xs:include` documents it references, and writes the results under
 * `fixtures/wsdl/public/<name>/` along with a `manifest.json`. Finally regenerates
 * `fixtures/wsdl/SOURCES.md` from all per-service manifests.
 *
 * Content is saved byte-exact, so a second run against unchanged sources produces no diff other
 * than an unchanged `fetchedAt` (only bumped when a file's sha256 actually changes). Run with
 * `pnpm fixtures:refresh`.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveFilename, extractReferences, resolveReferenceUrl } from './lib/wsdl-references.ts';

const USER_AGENT = 'wirebench-fixtures/0.1';
const REQUEST_TIMEOUT_MS = 20_000;

interface ServiceDefinition {
  readonly name: string;
  readonly url: string;
}

const SERVICES: readonly ServiceDefinition[] = [
  { name: 'calculator', url: 'http://www.dneonline.com/calculator.asmx?WSDL' },
  { name: 'tempconvert', url: 'https://www.w3schools.com/xml/tempconvert.asmx?WSDL' },
  {
    name: 'countryinfo',
    url: 'http://webservices.oorsprong.org/websamples.countryinfo/CountryInfoService.wso?WSDL',
  },
  { name: 'numberconversion', url: 'https://www.dataaccess.com/webservicesserver/NumberConversion.wso?WSDL' },
  { name: 'soapdemo', url: 'https://www.crcind.com/csp/samples/SOAP.Demo.cls?WSDL=1' },
];

interface ManifestFileEntry {
  readonly file: string;
  readonly url: string;
  readonly sha256: string;
  readonly bytes: number;
}

interface Manifest {
  readonly name: string;
  readonly sourceUrl: string;
  readonly fetchedAt: string;
  readonly files: ManifestFileEntry[];
}

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptDir, '..');
const fixturesRoot = join(repoRoot, 'fixtures', 'wsdl', 'public');

/** Fetches `url` with the fixtures User-Agent and a per-request timeout, returning the raw bytes. */
async function fetchBytes(url: string): Promise<Buffer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  } finally {
    clearTimeout(timer);
  }
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Returns true when `bytes` looks like an HTML error page rather than XML — i.e. the download
 * failed at the HTTP layer but returned a 200 anyway (common with hosted demo endpoints).
 */
function looksLikeHtml(bytes: Buffer): boolean {
  const head = bytes.subarray(0, 512).toString('utf8').trimStart().toLowerCase();
  return head.startsWith('<!doctype html') || head.startsWith('<html');
}

/** Downloads one service's WSDL plus every document it references, recursively. */
async function downloadService(
  service: ServiceDefinition,
): Promise<{ files: ManifestFileEntry[]; usedNames: Set<string> } | undefined> {
  const usedNames = new Set<string>();
  const files: ManifestFileEntry[] = [];
  const visited = new Set<string>();
  const queue: string[] = [service.url];
  const dir = join(fixturesRoot, service.name);
  await mkdir(dir, { recursive: true });

  while (queue.length > 0) {
    const url = queue.shift();
    if (url === undefined || visited.has(url)) {
      continue;
    }
    visited.add(url);

    let bytes: Buffer;
    try {
      bytes = await fetchBytes(url);
    } catch (error) {
      console.warn(`[${service.name}] failed to fetch ${url}: ${(error as Error).message}`);
      continue;
    }

    if (looksLikeHtml(bytes)) {
      console.warn(`[${service.name}] ${url} returned HTML, treating as failure`);
      continue;
    }

    const filename = url === service.url ? 'service.wsdl' : deriveFilename(url, usedNames);
    usedNames.add(filename);
    await writeFile(join(dir, filename), bytes);
    files.push({ file: filename, url, sha256: sha256(bytes), bytes: bytes.byteLength });

    const text = bytes.toString('utf8');
    for (const reference of extractReferences(text)) {
      queue.push(resolveReferenceUrl(url, reference));
    }
  }

  if (files.length === 0) {
    console.warn(`[${service.name}] no files downloaded`);
    return undefined;
  }
  return { files, usedNames };
}

/** Reads the previous manifest for `name`, if any, so unchanged files can keep their `fetchedAt`. */
async function readPreviousManifest(name: string): Promise<Manifest | undefined> {
  try {
    const raw = await readFile(join(fixturesRoot, name, 'manifest.json'), 'utf8');
    return JSON.parse(raw) as Manifest;
  } catch {
    return undefined;
  }
}

/** Regenerates `fixtures/wsdl/SOURCES.md` from all per-service manifests. */
async function writeSourcesIndex(manifests: readonly Manifest[]): Promise<void> {
  const lines: string[] = [
    '# Public WSDL fixture sources',
    '',
    'Auto-generated by `pnpm fixtures:refresh`. Do not edit by hand.',
    '',
  ];
  for (const manifest of manifests) {
    lines.push(`## ${manifest.name}`, '', `- Source: ${manifest.sourceUrl}`, `- Fetched: ${manifest.fetchedAt}`, '');
    lines.push('| File | sha256 | Bytes |', '| --- | --- | --- |');
    for (const file of manifest.files) {
      lines.push(`| ${file.file} | \`${file.sha256}\` | ${file.bytes} |`);
    }
    lines.push('');
  }
  await writeFile(join(repoRoot, 'fixtures', 'wsdl', 'SOURCES.md'), lines.join('\n') + '\n');
}

async function main(): Promise<void> {
  const manifests: Manifest[] = [];
  let anyFixtureEmpty = false;

  for (const service of SERVICES) {
    const previous = await readPreviousManifest(service.name);
    const result = await downloadService(service);

    if (result === undefined) {
      if (previous !== undefined && previous.files.length > 0) {
        console.warn(`[${service.name}] keeping existing fixture (download failed)`);
        manifests.push(previous);
      } else {
        anyFixtureEmpty = true;
      }
      continue;
    }

    const previousByFile = new Map(previous?.files.map((file) => [file.file, file]) ?? []);
    const changed = result.files.some((file) => previousByFile.get(file.file)?.sha256 !== file.sha256);
    const sameFileSet =
      previous !== undefined &&
      previous.files.length === result.files.length &&
      result.files.every((file) => previousByFile.has(file.file));
    const fetchedAt = !changed && sameFileSet && previous !== undefined ? previous.fetchedAt : new Date().toISOString();

    const manifest: Manifest = {
      name: service.name,
      sourceUrl: service.url,
      fetchedAt,
      files: result.files,
    };
    await writeFile(join(fixturesRoot, service.name, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    manifests.push(manifest);
  }

  await writeSourcesIndex(manifests);

  if (anyFixtureEmpty) {
    console.error('One or more fixtures have no files at all; failing.');
    process.exitCode = 1;
  }
}

await main();
