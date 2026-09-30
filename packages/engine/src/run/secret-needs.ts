/**
 * Every secret a selection of requests will ask for, found before anything is sent, so a pipeline
 * can be told which variables to set (`wirebench secrets list`) and a run knows which names to
 * read. The generic part is here: every `${secret:name}` the request's own text reaches, and the
 * secrets its scripts list. What a protocol's configuration needs (effective auth, the request's
 * keystore, signing, WS-Security) is its module's answer, walking the same sources its send resolves.
 */
import { resolveScopes } from '../project/environments.js';
import type { Project, PropertyMap } from '../project/model.js';
import type { PropertyScopes } from '../project/properties.js';
import type { SelectedBase } from '../protocol/module.js';
import type { ProtocolRegistry } from '../protocol/registry.js';
import { defaultRegistry } from '../protocols.js';
import type { SelectedRequest } from '../protocols.js';
import { activeScripts } from '../script/request-scripts.js';
import type { SecretNeed } from '../secrets/env-names.js';
import { secretEnvName, secretPseudoRef } from '../secrets/secret-token.js';
import { resolveWorkspaceScopes, withActiveEnvironment } from '../workspace/environments.js';
import type { Workspace } from '../workspace/model.js';
import { secretNamesInValue } from './send-helpers.js';

export { secretNamesInValue } from './send-helpers.js';

/** One secret a run needs, and which requests need it. */
export interface LocatedSecretNeed extends SecretNeed {
  /** Display paths of the requests that need it. */
  readonly usedBy: readonly string[];
}

function tokenNeeds(selected: SelectedBase, scopeSets: readonly PropertyScopes[]): SecretNeed[] {
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

/** The generic needs of `selected`, then what its protocol's configuration needs. */
function needsOf(
  selected: SelectedBase,
  project: Project,
  scopeSets: readonly PropertyScopes[],
  registry: ProtocolRegistry,
): SecretNeed[] {
  const run = registry.find(selected.kind)?.run;
  return [...tokenNeeds(selected, scopeSets), ...(run !== undefined ? run.secretNeeds(selected, project) : [])];
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
 * workspace environment with its linked project environment. `registry` is the set of protocol
 * modules asked for their needs; the built-in ones by default.
 */
export function secretNeedsOf(
  selected: readonly SelectedRequest[],
  project: Project,
  overrides: PropertyMap = {},
  workspace?: Workspace,
  registry: ProtocolRegistry = defaultRegistry(),
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
    for (const need of needsOf(item, project, scopeSets, registry)) {
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
