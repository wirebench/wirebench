/**
 * Current values (cookie jar and current values spec §5.2): the session's own value for a variable,
 * laid over its committed value in the same scope before resolution. A host hands them in through
 * `RunContext.current`.
 *
 * A current value is typed by the user, never taken from a response, so it is a template like a
 * committed value and ADR-0015 is untouched. It only replaces a name its scope defines, and since
 * resolution drops disabled names afterwards, a disabled variable's current value does not apply.
 */
import type { Project, PropertyMap } from '../project/model.js';
import type { Workspace } from '../workspace/model.js';

/** The overlays of one run, keyed like the scopes they land on; environments by id. */
export interface CurrentValues {
  readonly global?: PropertyMap;
  readonly workspace?: PropertyMap;
  readonly workspaceEnvironments?: Readonly<Record<string, PropertyMap>>;
  readonly project?: PropertyMap;
  /** The run's project's own environments. */
  readonly projectEnvironments?: Readonly<Record<string, PropertyMap>>;
}

/** `properties` with each name it defines replaced by `current`'s value; the same map when nothing changes. */
export function overlayCurrent(properties: PropertyMap, current: PropertyMap | undefined): PropertyMap {
  if (current === undefined) {
    return properties;
  }
  let laid: Record<string, string> | undefined;
  for (const [name, value] of Object.entries(current)) {
    if (Object.hasOwn(properties, name)) {
      laid ??= { ...properties };
      laid[name] = value;
    }
  }
  return laid ?? properties;
}

/** The project, workspace and globals a run resolves, each scope with its current values laid over it. */
export function withCurrentValues(
  input: { readonly project: Project; readonly workspace?: Workspace; readonly globals: PropertyMap },
  current: CurrentValues | undefined,
): { readonly project: Project; readonly workspace?: Workspace; readonly globals: PropertyMap } {
  if (current === undefined) {
    return input;
  }
  const project: Project = {
    ...input.project,
    properties: overlayCurrent(input.project.properties, current.project),
    environments: input.project.environments.map((environment) => ({
      ...environment,
      properties: overlayCurrent(environment.properties, current.projectEnvironments?.[environment.id]),
    })),
  };
  const workspace: Workspace | undefined =
    input.workspace === undefined
      ? undefined
      : {
          ...input.workspace,
          properties: overlayCurrent(input.workspace.properties, current.workspace),
          environments: input.workspace.environments.map((environment) => ({
            ...environment,
            properties: overlayCurrent(environment.properties, current.workspaceEnvironments?.[environment.id]),
          })),
        };
  return {
    project,
    ...(workspace !== undefined ? { workspace } : {}),
    globals: overlayCurrent(input.globals, current.global),
  };
}
