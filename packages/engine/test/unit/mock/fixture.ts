/**
 * Projects for mock tests: a temporary folder holding a SOAP interface and a REST API, each with its
 * definition cached from the repository's fixtures, as an import with "cache definitions" leaves them.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createDefaultFetchDocument } from '#core/http/fetch-document';
import type { MockDef } from '#core/mock/model';
import { createProject } from '#core/project/model';
import { createInterface } from '#protocol-soap/soap/model';
import type { Project } from '#core/project/model';
import { apiDefinitionDir, definitionCacheDir } from '#core/project/paths';
import { saveProject } from '#core/project/save';
import { writeApiDefinitionCache } from '#protocol-rest/rest/openapi/cache';
import { parseOpenApi } from '#protocol-rest/rest/openapi/import';
import { createApi } from '#protocol-rest/rest/model';
import { writeDefinitionCache } from '#protocol-soap/wsdl/cache';
import { resolveDefinition } from '#protocol-soap/wsdl/resolver';
import type { FetchDocument } from '#protocol-soap/wsdl/resolver';
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
    project = { ...project, containers: { ...project.containers, soap: [iface] } };
  }
  if (options.openapi !== undefined) {
    const api = createApi('Api', { id: 'A1', slug: 'api', order: 1 });
    project = { ...project, containers: { ...project.containers, rest: [api] } };
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
