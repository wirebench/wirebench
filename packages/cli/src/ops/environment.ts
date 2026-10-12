import { appliesToProject, isProtectedEnvironment } from '@wirebench/engine';
import type { Environment, Project, RunWorkspace, WorkspaceEnvironment } from '@wirebench/engine';
import type { Gates } from './context.js';
import { OpsError } from './errors.js';

/**
 * The environment by name first, then by slug or id; required as soon as there is any in scope.
 * Inside a workspace the environments are the workspace's, as in the app: a project environment
 * applies through the workspace environment of the same slug, never on its own. With a `projectId`
 * only the environments that apply to that project match; a name that exists but is out of scope
 * fails `environment-out-of-scope`, listing the ones in scope. Shared with `wirebench run`.
 */
export function pickEnvironment<E extends Environment | WorkspaceEnvironment>(
  environments: readonly E[],
  owner: 'project' | 'workspace',
  wanted: string | undefined,
  projectId?: string,
): E | undefined {
  const matches = (e: E): boolean =>
    wanted !== undefined && (e.name === wanted || e.slug === wanted || e.id === wanted);
  const inScope =
    projectId === undefined
      ? environments
      : environments.filter((e) => appliesToProject(e as WorkspaceEnvironment, projectId));
  if (inScope.length === 0) {
    if (wanted !== undefined) {
      if (environments.some(matches)) {
        throw outOfScope(wanted, []);
      }
      // Scoped to a project, an empty list may only mean none applies to it, not that none exists.
      const none = projectId === undefined ? `this ${owner} defines none` : 'no environment applies to this project';
      throw new OpsError('environment-not-found', `unknown environment "${wanted}": ${none}`, {
        environment: wanted,
      });
    }
    return undefined;
  }
  const names = inScope.map((e) => e.name).join(', ');
  if (wanted === undefined) {
    throw new OpsError('environment-required', `an environment is required (--env <name>); environments: ${names}`);
  }
  const found = inScope.find((e) => e.name === wanted) ?? inScope.find((e) => e.slug === wanted || e.id === wanted);
  if (found === undefined) {
    const hidden = environments.find((e) => e.name === wanted) ?? environments.find(matches);
    if (hidden !== undefined) {
      throw outOfScope(
        hidden.name,
        inScope.map((e) => e.name),
      );
    }
    throw new OpsError('environment-not-found', `unknown environment "${wanted}"; environments: ${names}`, {
      environment: wanted,
    });
  }
  return found;
}

function outOfScope(name: string, inScope: readonly string[]): OpsError {
  const available = inScope.length === 0 ? 'none apply to it' : `environments for it: ${inScope.join(', ')}`;
  return new OpsError(
    'environment-out-of-scope',
    `the environment "${name}" does not apply to this project; ${available}`,
    {
      environment: name,
    },
  );
}

/** The id the workspace gives the project at `projectSlug`, the key of an environment's scope. */
export function projectIdOf(workspace: RunWorkspace): string | undefined {
  return workspace.workspace.projects.find((ref) => ref.slug === workspace.projectSlug)?.id;
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
