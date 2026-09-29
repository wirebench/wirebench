import type { Environment, WorkspaceEnvironment } from '@wirebench/engine';
import { OpsError } from './errors.js';

/**
 * The environment by name first, then by slug or id; required as soon as there is any. Inside a
 * workspace the environments are the workspace's, as in the app. Shared with `wirebench run`.
 */
export function pickEnvironment<E extends Environment | WorkspaceEnvironment>(
  environments: readonly E[],
  owner: 'project' | 'workspace',
  wanted: string | undefined,
): E | undefined {
  if (environments.length === 0) {
    if (wanted !== undefined) {
      throw new OpsError('environment-not-found', `unknown environment "${wanted}": this ${owner} defines none`, {
        environment: wanted,
      });
    }
    return undefined;
  }
  const names = environments.map((e) => e.name).join(', ');
  if (wanted === undefined) {
    throw new OpsError('environment-required', `an environment is required (--env <name>); environments: ${names}`);
  }
  const found =
    environments.find((e) => e.name === wanted) ?? environments.find((e) => e.slug === wanted || e.id === wanted);
  if (found === undefined) {
    throw new OpsError('environment-not-found', `unknown environment "${wanted}"; environments: ${names}`, {
      environment: wanted,
    });
  }
  return found;
}

/** `wirebench mcp --env a,b`: a send may use only the environments listed (spec §4). */
export function checkAllowed(
  environment: Environment | WorkspaceEnvironment | undefined,
  allowed: readonly string[] | undefined,
): void {
  if (allowed === undefined || environment === undefined) {
    return;
  }
  if (![environment.name, environment.slug, environment.id].some((key) => allowed.includes(key))) {
    throw new OpsError(
      'environment-not-allowed',
      `the environment "${environment.name}" is not in this server's --env list (${allowed.join(', ')})`,
      { environment: environment.name },
    );
  }
}
