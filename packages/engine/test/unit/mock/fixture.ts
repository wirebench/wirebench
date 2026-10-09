/**
 * Projects for mock tests: a temporary folder holding a SOAP interface and a REST API, each with its
 * definition cached from the repository's fixtures, as an import with "cache definitions" leaves them.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createDefaultFetchDocument } from '../../../src/http/fetch-document.js';
import type { MockDef } from '../../../src/mock/model.js';
import { createInterface, createProject } from '../../../src/project/model.js';
import type { Project } from '../../../src/project/model.js';
import { apiDefinitionDir, definitionCacheDir } from '../../../src/project/paths.js';
import { saveProject } from '../../../src/project/save.js';
import { writeApiDefinitionCache } from '../../../src/rest/openapi/cache.js';
import { parseOpenApi } from '../../../src/rest/openapi/import.js';
import { createApi } from '../../../src/rest/model.js';
import { writeDefinitionCache } from '../../../src/wsdl/cache.js';
import { resolveDefinition } from '../../../src/wsdl/resolver.js';
import type { FetchDocument } from '../../../src/wsdl/resolver.js';
import { tempProjectDir } from '../project/fixture.js';

const fixtures = fileURLToPath(new URL('../../../../../fixtures/', import.meta.url));

/** A WSDL under `fixtures/wsdl/`, e.g. `public/calculator/service.wsdl`. */
export function wsdlFixture(relative: string): string {
  return pathToFileURL(join(fixtures, 'wsdl', relative)).href;
}

/** An OpenAPI document under `fixtures/openapi/`. */
export function openApiFixture(relative: string): string {
  return pathToFileURL(join(fixtures, 'openapi', relative)).href;
}

const readFixture = ((location: string) => {
  const text = readFileSync(fileURLToPath(location), 'utf-8');
  return Promise.resolve({ location, bytes: new TextEncoder().encode(text), text });
}) as FetchDocument;

export interface MockProject {
  readonly dir: string;
  readonly project: Project;
}

/**
 * A saved project with an interface `I1` (when `wsdl` is given) and an API `A1` (when `openapi` is
 * given), both with their definitions cached, plus `mocks`.
 */
export async function mockProject(options: {
  readonly wsdl?: string;
  readonly openapi?: string;
  readonly mocks?: readonly MockDef[];
}): Promise<MockProject> {
  const dir = await tempProjectDir();
  let project: Project = createProject('Mocks', { id: 'P1' });
  if (options.wsdl !== undefined) {
    const iface = createInterface('Service', { id: 'I1', slug: 'service', definitionUrl: options.wsdl });
    project = { ...project, interfaces: [iface] };
  }
  if (options.openapi !== undefined) {
    const api = createApi('Api', { id: 'A1', slug: 'api', order: 1 });
    project = { ...project, apis: [api] };
  }
  project = { ...project, mocks: options.mocks ?? [] };
  await saveProject(project, dir);
  if (options.wsdl !== undefined) {
    const bundle = await resolveDefinition({ location: options.wsdl }, { fetchDocument: createDefaultFetchDocument() });
    await writeDefinitionCache(bundle, definitionCacheDir(dir, 'service'));
  }
  if (options.openapi !== undefined) {
    const parsed = await parseOpenApi({ kind: 'file', path: options.openapi }, { fetchDocument: readFixture });
    await writeApiDefinitionCache(parsed.documents, apiDefinitionDir(dir, 'api'));
  }
  return { dir, project };
}
