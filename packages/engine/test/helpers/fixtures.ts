import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));

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
