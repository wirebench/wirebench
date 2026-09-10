import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));

/** Reads a public WSDL fixture (`fixtures/wsdl/public/<name>/service.wsdl`) from the repo root. */
export function readPublicFixture(name: string): string {
  return readFileSync(`${repoRoot}fixtures/wsdl/public/${name}/service.wsdl`, 'utf-8');
}
