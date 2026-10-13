import {
  appliesToProject,
  isProtectedEnvironment,
  isWirebenchError,
  pickEnvironment as pickInEngine,
  projectIdOf,
} from '@wirebench/engine';
import type { Environment, Project, RunWorkspace, WorkspaceEnvironment } from '@wirebench/engine';
import type { Gates } from './context.js';
import { OpsError } from './errors.js';

export { projectIdOf };

/**
 * The environment by name first, then by slug or id; required as soon as there is any in scope. The
 * engine's pick (shared with a server running a schedule), its refusals as `OpsError`s.
 */
export function pickEnvironment<E extends Environment | WorkspaceEnvironment>(
  environments: readonly E[],
  owner: 'project' | 'workspace',
  wanted: string | undefined,
  projectId?: string,
): E | undefined {
  try {
    return pickInEngine(environments, owner, wanted, projectId);
  } catch (error) {
    if (isWirebenchError(error)) {
      throw new OpsError(error.code, error.message, error.details);
    }
    throw error;
  }
}

/**
 * `wirebench mcp --env a,b`: a send may use only the environments listed (spec §4). A send under no
 * environment at all (a project that defines none) is outside every list, so it is refused too.
 */
export function checkAllowed(
  environment: Environment | WorkspaceEnvironment | undefined,
  allowed: readonly string[] | undefined,
): void {
  if (allowed === undefined) {
    return;
  }
  if (environment === undefined) {
    throw new OpsError(
      'environment-not-allowed',
      `this server's --env list (${allowed.join(', ')}) allows only those environments, and this project defines none to send under`,
    );
  }
  if (![environment.name, environment.slug, environment.id].some((key) => allowed.includes(key))) {
    throw new OpsError(
      'environment-not-allowed',
      `the environment "${environment.name}" is not in this server's --env list (${allowed.join(', ')})`,
      { environment: environment.name },
    );
  }
}

/**
 * `wirebench mcp`: a send under a protected environment (#345) needs the call's `allowProtected`,
 * so an agent never reaches production by default. The CLI's own verbs run with open gates.
 */
export function checkProtected(
  project: Project,
  environment: Environment | WorkspaceEnvironment | undefined,
  gates: Pick<Gates, 'refuseProtected'>,
  allowProtected: boolean,
): void {
  if (gates.refuseProtected !== true || allowProtected || !isProtectedEnvironment(project, environment)) {
    return;
  }
  const name = environment?.name ?? '';
  throw new OpsError(
    'environment-protected',
    `the environment "${name}" is protected; pass allowProtected: true to send under it`,
    { environment: name },
  );
}

/**
 * The `--env` names that can apply to the project: a name that matches only environments out of scope
 * is dropped, so a tool description never offers an environment the pick would refuse.
 */
export function gateNamesInScope(names: readonly string[], workspace: RunWorkspace | undefined): readonly string[] {
  const projectId = workspace === undefined ? undefined : projectIdOf(workspace);
  if (workspace === undefined || projectId === undefined) {
    return names;
  }
  const all = workspace.workspace.environments;
  return names.filter((name) => {
    const matching = all.filter((e) => e.name === name || e.slug === name || e.id === name);
    return matching.length === 0 || matching.some((e) => appliesToProject(e, projectId));
  });
}
