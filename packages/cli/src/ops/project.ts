/**
 * The project, read fresh for every op (spec §2), so the next call sees what the desktop just saved;
 * and the cached contracts the ops read it through.
 */
import { join } from 'node:path';
import {
  buildSchemaSet,
  definitionCacheDir,
  loadOpenApiDocument,
  loadProject,
  parseWsdlBundle,
  readDefinitionCache,
} from '@wirebench/engine';
import type {
  DefinitionBundle,
  Environment,
  Interface,
  OpenApiDocument,
  Project,
  QName,
  RestApi,
  RunWorkspace,
  SchemaSet,
  WorkspaceEnvironment,
  WsdlDefinition,
} from '@wirebench/engine';
import { enclosingWorkspace, exists } from '../workspace-lookup.js';
import type { OpsContext } from './context.js';
import { checkAllowed, pickEnvironment } from './environment.js';
import { OpsError } from './errors.js';

export interface OpenedProject {
  readonly project: Project;
  readonly workspace?: RunWorkspace;
}

/**
 * @throws OpsError `workspace-not-project`; ProjectError `project-not-found` and the loader's codes
 */
export async function openProject(context: Pick<OpsContext, 'projectDir' | 'warn'>): Promise<OpenedProject> {
  const dir = context.projectDir;
  if (!(await exists(join(dir, 'wirebench.yaml'))) && (await exists(join(dir, 'workspace.yaml')))) {
    throw new OpsError('workspace-not-project', `${dir} is a workspace; pass --project with one of its projects`, {
      dir,
    });
  }
  const loaded = await loadProject(dir);
  for (const problem of loaded.problems) {
    context.warn(`${problem.code}: ${problem.message} (${problem.file})`);
  }
  const workspace = await enclosingWorkspace(dir, context.warn);
  return { project: loaded.project, ...(workspace !== undefined ? { workspace } : {}) };
}

/** The environment a send resolves under, checked against the `--env` list. */
export function environmentFor(
  opened: OpenedProject,
  wanted: string | undefined,
  allowed?: readonly string[],
): Environment | WorkspaceEnvironment | undefined {
  const environment =
    opened.workspace === undefined
      ? pickEnvironment(opened.project.environments, 'project', wanted)
      : pickEnvironment(opened.workspace.workspace.environments, 'workspace', wanted);
  checkAllowed(environment, allowed);
  return environment;
}

/** An interface's cached definition, compiled. */
export interface LoadedWsdl {
  readonly definition: WsdlDefinition;
  readonly bundle: DefinitionBundle;
  readonly schemaSet: SchemaSet;
}

/**
 * Reads `interfaces/<slug>/definition/` offline, as `wirebench run` does: the ops never fetch a WSDL.
 *
 * @throws OpsError `definition-cache-missing`
 */
export async function readWsdl(projectDir: string, iface: Interface): Promise<LoadedWsdl> {
  let bundle: DefinitionBundle;
  try {
    bundle = await readDefinitionCache(definitionCacheDir(projectDir, iface.slug));
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new OpsError(
      'definition-cache-missing',
      `The interface "${iface.name}" has no readable cached definition (${reason}); import it again with definitions cached`,
      { interface: iface.name, reason },
    );
  }
  return { definition: parseWsdlBundle(bundle), bundle, schemaSet: buildSchemaSet(bundle) };
}

/** @throws OpsError `definition-cache-missing` */
export async function readOpenApi(projectDir: string, api: RestApi): Promise<OpenApiDocument> {
  const document = await loadOpenApiDocument(projectDir, api.slug);
  if (document === undefined) {
    throw new OpsError(
      'definition-cache-missing',
      `The API "${api.name}" has no readable cached OpenAPI document; import it again with definitions cached`,
      { api: api.name },
    );
  }
  return document;
}

/** `{namespace}local` as a QName; a bare name has the empty namespace. */
export function clarkToQName(clark: string): QName {
  const match = /^\{([^}]*)\}(.*)$/.exec(clark);
  return match === null
    ? { namespaceUri: '', localName: clark }
    : { namespaceUri: match[1] ?? '', localName: match[2] ?? '' };
}
