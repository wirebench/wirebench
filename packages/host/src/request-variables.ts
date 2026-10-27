/**
 * What `request.variables` answers (#340): every variable one request can reference, in the order the
 * shorthand `${name}` searches them, so the editor can complete names, explain a reference on hover
 * and mark one that resolves to nothing — against the very scopes the request's send expands with.
 *
 * A secret never crosses: a value is expanded with no secrets and no process environment, and one
 * that reaches a `${secret:…}` token or a `${#System#…}` variable goes over masked, without its value.
 * System variables go over by name only, so a `${#System#HOME}` is not marked unresolved. A value
 * that generates a `${$…}` one (#333) goes over as written, since every send makes a new one.
 *
 * Pure: no `electron`, no `fs`.
 */
import { expand, linkedEnvironment, propertyReferences } from '@wirebench/engine';
import type { PropertyMap, PropertyScopes } from '@wirebench/engine';
import type { ProjectRouter } from './project-router.js';
import type { RequestVariablesResponse, RequestVariableWire, VariableEditTargetWire } from '@wirebench/wire/wire-base';

/** Where the request runs: what `runContextFor` reports, the part this module reads. */
export type VariablesLocation = Pick<
  NonNullable<ReturnType<ProjectRouter['runContextFor']>>,
  'project' | 'workspace' | 'environmentId'
>;

export interface RequestVariablesInput {
  /** The scopes the request's send expands against (`ProjectRouter.scopesFor`). */
  readonly scopes: PropertyScopes;
  readonly located: VariablesLocation | undefined;
  /** The `${secret:name}` names this request may read: stored on this machine, or mapped to a source. */
  readonly secretNames: readonly string[];
}

type ChainScope = Exclude<RequestVariableWire['scope'], 'System'>;

/** Where the editor goes to change an Env variable: the environment that actually defines it. */
function envTarget(located: VariablesLocation | undefined, name: string): VariableEditTargetWire | undefined {
  if (located === undefined) return undefined;
  const run = located.workspace;
  if (run === undefined) {
    return located.environmentId === undefined ? undefined : { kind: 'environment', id: located.environmentId };
  }
  const active = run.workspace.environments.find((environment) => environment.id === run.workspace.activeEnvironmentId);
  const linked = linkedEnvironment(located.project, active);
  if (linked !== undefined && Object.hasOwn(linked.properties, name)) {
    return { kind: 'environment', id: linked.id };
  }
  return active === undefined ? undefined : { kind: 'environment', id: active.id };
}

function editTarget(
  scope: ChainScope,
  located: VariablesLocation | undefined,
  name: string,
): VariableEditTargetWire | undefined {
  switch (scope) {
    case 'Env':
      return envTarget(located, name);
    case 'Project':
      return located === undefined ? undefined : { kind: 'project', projectId: located.project.id };
    case 'Workspace':
      return { kind: 'workspace' };
    case 'Global':
      return { kind: 'globals' };
  }
}

/** The scopes as the display expands against them: no secret, and no process environment. */
function displayScopes(scopes: PropertyScopes): PropertyScopes {
  const display: { -readonly [K in keyof PropertyScopes]: PropertyScopes[K] } = { ...scopes, system: {} };
  delete display.secrets;
  delete display.onSystemRead;
  return display;
}

/** One variable's entry: its value expanded, or masked when the expansion reaches a secret or System. */
function entryFor(
  name: string,
  raw: string,
  scope: ChainScope,
  shadowed: boolean,
  input: RequestVariablesInput,
  display: PropertyScopes,
): RequestVariableWire {
  const expanded = expand(raw, display);
  const secret = propertyReferences(raw).find((reference) => reference.form === 'secret');
  const masked =
    secret !== undefined ||
    expanded.unresolved.some((ref) => ref.scope === 'Secret' || ref.scope === 'System') ||
    expanded.used.some((used) => used.scope === 'Secret' || used.scope === 'System');
  // A generated value would be one sample the send never uses: such a value is shown as written.
  const dynamic = expanded.used.some((used) => used.scope === 'Dynamic');
  const edit = editTarget(scope, input.located, name);
  return {
    name,
    scope,
    ...(masked ? {} : { value: dynamic ? raw : expanded.text }),
    masked,
    ...(secret !== undefined ? { secretName: secret.name } : {}),
    shadowed,
    ...(edit !== undefined ? { edit } : {}),
  };
}

/** Every variable `input`'s request can reference, nearest scope first; System names last. */
export function requestVariables(input: RequestVariablesInput): RequestVariablesResponse {
  const { scopes } = input;
  const display = displayScopes(scopes);
  const chain: readonly (readonly [ChainScope, PropertyMap | undefined])[] = [
    ['Env', scopes.env],
    ['Project', scopes.project],
    ['Workspace', scopes.workspace],
    ['Global', scopes.global],
  ];
  const seen = new Set<string>();
  const entries: RequestVariableWire[] = [];
  for (const [scope, map] of chain) {
    for (const [name, raw] of Object.entries(map ?? {})) {
      entries.push(entryFor(name, raw, scope, seen.has(name), input, display));
      seen.add(name);
    }
  }
  for (const name of Object.keys(scopes.system ?? {}).sort()) {
    entries.push({ name, scope: 'System', masked: true, shadowed: false });
  }
  return { entries, secretNames: [...input.secretNames] };
}
