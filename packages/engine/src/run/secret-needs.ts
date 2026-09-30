/**
 * Every secret a selection of requests will ask for, found before anything is sent, so a pipeline
 * can be told which variables to set (`wirebench secrets list`) and a run knows which names to
 * read. It walks the same sources `prepareSend` resolves: effective auth, the request's keystore,
 * and the WS-Security configurations it selects, with the keystores those lead to.
 */
import { grpcRun } from '../grpc/run.js';
import { resolveScopes } from '../project/environments.js';
import type { PropertyScopes } from '../project/properties.js';
import type { Project, PropertyMap } from '../project/model.js';
import type { SecretNeed } from '../secrets/env-names.js';
import { secretEnvName, secretPseudoRef } from '../secrets/secret-token.js';
import { restRun } from '../rest/run.js';
import { activeScripts } from '../script/request-scripts.js';
import { soapRun } from '../soap/run.js';
import { resolveWorkspaceScopes, withActiveEnvironment } from '../workspace/environments.js';
import type { Workspace } from '../workspace/model.js';
import type { SelectedRequest } from './select.js';
import { secretNamesInValue } from './send-helpers.js';

export { secretNamesInValue } from './send-helpers.js';

/** One secret a run needs, and which requests need it. */
export interface LocatedSecretNeed extends SecretNeed {
  /** Display paths of the requests that need it. */
  readonly usedBy: readonly string[];
}

function tokenNeeds(selected: SelectedRequest, scopeSets: readonly PropertyScopes[]): SecretNeed[] {
  // A script's own text is code, not a template: nothing in it is a reference. The secrets its
  // request lists for `secrets.get` are needed instead (#63).
  const { scripts, ...request } = selected.request;
  const names = new Set(scopeSets.flatMap((scopes) => secretNamesInValue(request, scopes)));
  for (const name of activeScripts(scripts)?.secrets ?? []) {
    names.add(name);
  }
  return [...names].map((name) => ({
    ref: secretPseudoRef(name),
    envName: secretEnvName(name),
    purpose: `secret "${name}"`,
  }));
}

function needsOf(selected: SelectedRequest, project: Project, scopeSets: readonly PropertyScopes[]): SecretNeed[] {
  if (selected.kind === 'rest') {
    return [...tokenNeeds(selected, scopeSets), ...restRun.secretNeeds(selected, project)];
  }
  if (selected.kind === 'grpc') {
    return [...tokenNeeds(selected, scopeSets), ...grpcRun.secretNeeds(selected, project)];
  }
  return [...tokenNeeds(selected, scopeSets), ...soapRun.secretNeeds(selected, project)];
}

/** A workspace's scopes with no environment active, then under each of its environments in turn. */
function workspaceScopeSets(workspace: Workspace, project: Project): PropertyScopes[] {
  return [undefined, ...workspace.environments.map((environment) => environment.id)].map((environmentId) =>
    resolveWorkspaceScopes({ workspace: withActiveEnvironment(workspace, environmentId), project, globals: {} }),
  );
}

/**
 * The secrets `selected` needs, one entry per ref in first-use order, each with every request
 * that uses it. The first declaration of a ref supplies its name and purpose. `overrides` are the
 * run's `--var` properties, laid over the environment's as a send lays them. With a `workspace`
 * the scopes are the ones a send inside it expands against: the workspace's properties, and each
 * workspace environment with its linked project environment.
 */
export function secretNeedsOf(
  selected: readonly SelectedRequest[],
  project: Project,
  overrides: PropertyMap = {},
  workspace?: Workspace,
): LocatedSecretNeed[] {
  const byRef = new Map<string, { need: SecretNeed; usedBy: string[] }>();
  // A token a property holds counts whichever environment a run picks: project properties alone,
  // then each environment laid over them. No process environment, so this stays pure.
  const withOverrides = (scopes: PropertyScopes): PropertyScopes => ({
    ...scopes,
    env: { ...(scopes.env ?? {}), ...overrides },
  });
  const scopeSets = (
    workspace === undefined
      ? [
          resolveScopes(project, undefined, {}, {}),
          ...project.environments.map((environment) => resolveScopes(project, environment.id, {}, {})),
        ]
      : workspaceScopeSets(workspace, project)
  ).map(withOverrides);
  for (const item of selected) {
    for (const need of needsOf(item, project, scopeSets)) {
      const known = byRef.get(need.ref);
      if (known === undefined) {
        byRef.set(need.ref, { need, usedBy: [item.path] });
      } else {
        if (!known.usedBy.includes(item.path)) {
          known.usedBy.push(item.path);
        }
        if (known.need.envName === undefined && need.envName !== undefined) {
          known.need = { ...known.need, envName: need.envName };
        }
      }
    }
  }
  return [...byRef.values()].map(({ need, usedBy }) => ({ ...need, usedBy }));
}
