import { WirebenchError } from '../errors.js';
import type { Environment } from '../project/model.js';
import { appliesToProject } from '../workspace/environments.js';
import type { WorkspaceEnvironment } from '../workspace/model.js';
import type { RunWorkspace } from './context.js';

/**
 * The environment by name first, then by slug or id; required as soon as there is any in scope.
 * Inside a workspace the environments are the workspace's, as in the app: a project environment
 * applies through the workspace environment of the same slug, never on its own. With a `projectId`
 * only the environments that apply to that project match; a name that exists but is out of scope
 * fails `environment-out-of-scope`, listing the ones in scope. Shared by `wirebench run`, its ops and a server running a schedule.
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
      throw new WirebenchError('environment-not-found', `unknown environment "${wanted}": ${none}`, {
        details: { environment: wanted },
      });
    }
    return undefined;
  }
  const names = inScope.map((e) => e.name).join(', ');
  if (wanted === undefined) {
    throw new WirebenchError(
      'environment-required',
      `an environment is required (--env <name>); environments: ${names}`,
    );
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
    throw new WirebenchError('environment-not-found', `unknown environment "${wanted}"; environments: ${names}`, {
      details: { environment: wanted },
    });
  }
  return found;
}

function outOfScope(name: string, inScope: readonly string[]): WirebenchError {
  const available = inScope.length === 0 ? 'none apply to it' : `environments for it: ${inScope.join(', ')}`;
  return new WirebenchError(
    'environment-out-of-scope',
    `the environment "${name}" does not apply to this project; ${available}`,
    { details: { environment: name } },
  );
}

/** The id the workspace gives the project at `projectSlug`, the key of an environment's scope. */
export function projectIdOf(workspace: RunWorkspace): string | undefined {
  return workspace.workspace.projects.find((ref) => ref.slug === workspace.projectSlug)?.id;
}
