/**
 * Downloads the public fixture sets used by parser and import tests.
 *
 * **WSDL** — for each service in {@link SERVICES}, fetches the WSDL, recursively downloads any
 * `wsdl:import`/`xs:import`/`xs:include` documents it references, and writes the results under
 * `fixtures/wsdl/public/<name>/` along with a `manifest.json`. Finally regenerates
 * `fixtures/wsdl/SOURCES.md` from all per-service manifests.
 *
 * **OpenAPI** — for each entry in {@link OPENAPI_FIXTURES}, fetches the npm package tarball it names
 * (once per package), lifts the one document out of it, and writes it under
 * `fixtures/openapi/public/<name>/` with its own `manifest.json`; `fixtures/openapi/SOURCES.md` is
 * regenerated the same way. The registry is the source rather than a project's own website
 * because a published version is immutable and attributable: the tarball's hash names exactly
 * what was vendored, and the package's licence covers the copy.
 *
 * Content is saved byte-exact, so a second run against unchanged sources produces no diff other
 * than an unchanged `fetchedAt` (only bumped when a file's sha256 actually changes). Run with
 * `pnpm fixtures:refresh`, or `pnpm fixtures:refresh wsdl` / `pnpm fixtures:refresh openapi` for
 * one set alone.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readTarGz } from './lib/tar.ts';
import { deriveFilename, extractReferences, resolveReferenceUrl } from './lib/wsdl-references.ts';
import { writeLargeOpenApiFixture } from '../packages/engine/test/helpers/large-openapi.ts';
import { writeLargeSchemaFixture } from '../packages/engine/test/helpers/large-schema.ts';

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

/** One OpenAPI document to vendor from a published npm package. */
interface OpenApiFixtureDefinition {
  /** Folder name under `fixtures/openapi/public/`. */
  readonly name: string;
  readonly package: string;
  readonly version: string;
  /** The document's path inside the package, without the tarball's `package/` prefix. */
  readonly file: string;
  /**
   * The licence the *document* is under, where it declares one of its own (`info.license`);
   * otherwise the package's. Recorded so `SOURCES.md` says what the copy is covered by.
   */
  readonly license: string;
  readonly attribution: string;
}

/**
 * Two documents, one per specification version, both cleanly licensed: the canonical Swagger
 * Petstore (Apache 2.0, and the shape most third-party tooling is tested against), and a 3.1
 * document that exercises every security scheme type the specification defines.
 */
const OPENAPI_FIXTURES: readonly OpenApiFixtureDefinition[] = [
  {
    name: 'petstore-3.0',
    package: '@readme/oas-examples',
    version: '8.2.2',
    file: '3.0/json/petstore.json',
    license: 'Apache-2.0',
    attribution: 'Swagger Petstore, swagger.io (info.license: Apache 2.0)',
  },
  {
    name: 'security-3.1',
    package: '@readme/oas-examples',
    version: '8.2.2',
    file: '3.1/json/security.json',
    license: 'MIT',
    attribution: 'ReadMe, from the package itself (no info.license of its own)',
  },
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

/** What `fixtures/openapi/public/<name>/manifest.json` records. */
interface OpenApiManifest {
  readonly name: string;
  readonly package: string;
  readonly version: string;
  readonly tarball: string;
  readonly tarballSha256: string;
  readonly file: string;
  readonly license: string;
  readonly attribution: string;
  readonly fetchedAt: string;
  readonly files: ManifestFileEntry[];
}

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptDir, '..');
const fixturesRoot = join(repoRoot, 'fixtures', 'wsdl', 'public');
const openApiRoot = join(repoRoot, 'fixtures', 'openapi', 'public');

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

/** The registry URL of one package version's tarball. */
function tarballUrl(pkg: string, version: string): string {
  const bare = pkg.startsWith('@') ? pkg.slice(pkg.indexOf('/') + 1) : pkg;
  return `https://registry.npmjs.org/${pkg}/-/${bare}-${version}.tgz`;
}

/** Reads the previous OpenAPI manifest for `name`, if any, so unchanged files keep their `fetchedAt`. */
async function readPreviousOpenApiManifest(name: string): Promise<OpenApiManifest | undefined> {
  try {
    const raw = await readFile(join(openApiRoot, name, 'manifest.json'), 'utf8');
    return JSON.parse(raw) as OpenApiManifest;
  } catch {
    return undefined;
  }
}

/**
 * Vendors every entry of {@link OPENAPI_FIXTURES}, fetching each package tarball once. A package
 * that cannot be fetched keeps whatever its fixtures already have on disk, as the WSDL half does.
 */
async function downloadOpenApiFixtures(): Promise<{ manifests: OpenApiManifest[]; anyEmpty: boolean }> {
  const manifests: OpenApiManifest[] = [];
  let anyEmpty = false;
  const tarballs = new Map<string, Promise<{ bytes: Buffer; sha256: string } | undefined>>();

  for (const fixture of OPENAPI_FIXTURES) {
    const url = tarballUrl(fixture.package, fixture.version);
    let pending = tarballs.get(url);
    if (pending === undefined) {
      pending = fetchBytes(url)
        .then((bytes) => ({ bytes, sha256: sha256(bytes) }))
        .catch((error: unknown) => {
          console.warn(`[openapi] failed to fetch ${url}: ${(error as Error).message}`);
          return undefined;
        });
      tarballs.set(url, pending);
    }
    const previous = await readPreviousOpenApiManifest(fixture.name);
    const tarball = await pending;
    if (tarball === undefined) {
      if (previous !== undefined) {
        console.warn(`[${fixture.name}] keeping existing fixture (download failed)`);
        manifests.push(previous);
      } else {
        anyEmpty = true;
      }
      continue;
    }

    const wanted = `package/${fixture.file}`;
    const entry = readTarGz(new Uint8Array(tarball.bytes)).find((candidate) => candidate.name === wanted);
    if (entry === undefined) {
      console.warn(`[${fixture.name}] ${wanted} is not in ${url}`);
      if (previous !== undefined) {
        manifests.push(previous);
      } else {
        anyEmpty = true;
      }
      continue;
    }

    const extension = fixture.file.slice(fixture.file.lastIndexOf('.'));
    const fileName = `openapi${extension}`;
    const bytes = Buffer.from(entry.bytes);
    const dir = join(openApiRoot, fixture.name);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, fileName), bytes);

    const digest = sha256(bytes);
    const unchanged = previous?.files[0]?.sha256 === digest && previous.tarballSha256 === tarball.sha256;
    const manifest: OpenApiManifest = {
      name: fixture.name,
      package: fixture.package,
      version: fixture.version,
      tarball: url,
      tarballSha256: tarball.sha256,
      file: fixture.file,
      license: fixture.license,
      attribution: fixture.attribution,
      fetchedAt: unchanged && previous !== undefined ? previous.fetchedAt : new Date().toISOString(),
      files: [{ file: fileName, url: `${url}#${wanted}`, sha256: digest, bytes: bytes.byteLength }],
    };
    await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    manifests.push(manifest);
  }
  return { manifests, anyEmpty };
}

/** Regenerates `fixtures/openapi/SOURCES.md` from all per-fixture manifests. */
async function writeOpenApiSourcesIndex(manifests: readonly OpenApiManifest[]): Promise<void> {
  const lines: string[] = [
    '# Public OpenAPI fixture sources',
    '',
    'Auto-generated by `pnpm fixtures:refresh openapi`. Do not edit by hand.',
    '',
    'Each document is lifted byte-exact out of a published npm package, so the tarball hash names',
    'exactly what was vendored and the licence recorded covers the copy.',
    '',
  ];
  for (const manifest of manifests) {
    lines.push(
      `## ${manifest.name}`,
      '',
      `- Package: \`${manifest.package}@${manifest.version}\``,
      `- Tarball: ${manifest.tarball}`,
      `- Tarball sha256: \`${manifest.tarballSha256}\``,
      `- File in package: \`${manifest.file}\``,
      `- Licence: ${manifest.license} — ${manifest.attribution}`,
      `- Fetched: ${manifest.fetchedAt}`,
      '',
      '| File | sha256 | Bytes |',
      '| --- | --- | --- |',
    );
    for (const file of manifest.files) {
      lines.push(`| ${file.file} | \`${file.sha256}\` | ${file.bytes} |`);
    }
    lines.push('');
  }
  await writeFile(join(repoRoot, 'fixtures', 'openapi', 'SOURCES.md'), lines.join('\n') + '\n');
}

async function main(): Promise<void> {
  const only = process.argv[2];
  if (only !== undefined && only !== 'wsdl' && only !== 'openapi') {
    console.error(`Unknown fixture set "${only}": expected "wsdl", "openapi", or nothing for both.`);
    process.exitCode = 1;
    return;
  }
  if (only !== 'openapi') {
    await refreshWsdl();
  }
  if (only !== 'wsdl') {
    await refreshLargeOpenApi();
    const { manifests, anyEmpty } = await downloadOpenApiFixtures();
    await writeOpenApiSourcesIndex(manifests);
    if (anyEmpty) {
      console.error('One or more OpenAPI fixtures have no files at all; failing.');
      process.exitCode = 1;
    }
  }
}

async function refreshWsdl(): Promise<void> {
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
  await refreshLargeSchema();

  if (anyFixtureEmpty) {
    console.error('One or more fixtures have no files at all; failing.');
    process.exitCode = 1;
  }
}

/**
 * Regenerates the `crafted/large.json` OpenAPI performance fixture.
 *
 * ~1 MB of JSON, generated from a committed seed rather than committed itself, exactly as the
 * `large-schema` WSDL fixture is. The perf suite writes its own copy into a temp directory and does
 * not depend on this one.
 */
async function refreshLargeOpenApi(): Promise<void> {
  const dir = join(repoRoot, 'fixtures', 'openapi', 'crafted');
  const written = await writeLargeOpenApiFixture(dir);
  console.log(`[large-openapi] generated ${(written.bytes / 1024 / 1024).toFixed(2)} MB into ${written.file}`);
}

/**
 * Regenerates the `crafted/large-schema` performance fixture. It is ~5 MB, so it is generated
 * from {@link LARGE_SCHEMA_SEED} instead of being committed (see `.gitignore`); the perf suite
 * writes its own copy into a temp directory and does not depend on this one.
 */
async function refreshLargeSchema(): Promise<void> {
  const dir = join(repoRoot, 'fixtures', 'wsdl', 'crafted', 'large-schema');
  const written = await writeLargeSchemaFixture(dir);
  console.log(`[large-schema] generated ${(written.bytes / 1024 / 1024).toFixed(2)} MB into ${dir}`);
}

await main();
