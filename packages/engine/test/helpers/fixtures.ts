import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));

/**
 * A `file:` URL for `path`, which a test may write POSIX-style (`/tmp/x.wsdl`). The path is
 * resolved first, so on Windows it gains the current drive letter — `file:///tmp/x.wsdl` has
 * no drive and `fileURLToPath` rejects it there, which is not the thing under test.
 *
 * @param path the path, absolute or relative to the working directory
 */
export function fileUrl(path: string): string {
  return pathToFileURL(resolve(path)).href;
}

/** A `file:` URL for `fixtures/<relative>` in the repo, e.g. `wsdl/crafted/x/service.wsdl`. */
export function fixtureUrl(relative: string): string {
  return pathToFileURL(resolve(repoRoot, 'fixtures', relative)).href;
}

/** Reads a public WSDL fixture (`fixtures/wsdl/public/<name>/service.wsdl`) from the repo root. */
export function readPublicFixture(name: string): string {
  return readFileSync(`${repoRoot}fixtures/wsdl/public/${name}/service.wsdl`, 'utf-8');
}

/** Reads a crafted WSDL fixture (`fixtures/wsdl/crafted/<name>/service.wsdl`) from the repo root. */
export function readCraftedFixture(name: string): string {
  return readFileSync(`${repoRoot}fixtures/wsdl/crafted/${name}/service.wsdl`, 'utf-8');
}

/**
 * Reads a WSDL fixture by name, from `public/` when there is one there and from `crafted/`
 * otherwise — what the test SOAP server serves on `/service?wsdl`.
 */
export function readFixtureWsdl(name: string): string {
  try {
    return readPublicFixture(name);
  } catch {
    return readCraftedFixture(name);
  }
}
