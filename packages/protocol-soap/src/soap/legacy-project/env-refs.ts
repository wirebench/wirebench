/**
 * A pre-pass over a parsed legacy project that rewrites `${#Project#name}` references to `${name}`
 * when an imported environment defines `name` as a property. In the source tool, environment
 * properties override project properties, so such a reference already changes with the active
 * environment there; in Wirebench `${#Project#name}` only ever reads the project scope. Rewriting it
 * to the shorthand `${name}` (which resolves Env -> Project -> Workspace -> Global, see
 * `project/properties.ts`) makes the imported request behave the same way it did before the import,
 * silently — this is not a mapping loss, so it is never reported.
 *
 * Pure and byte-identical when nothing needs rewriting: a project with no environments (or none
 * defining any properties) is returned as the same object.
 */

import type {
  LegacyCall,
  LegacyEnvironment,
  LegacyInterface,
  LegacyOperation,
  LegacyProject,
  LegacyProperty,
} from './model.js';

const PROJECT_REF = /\$\{#Project#([^${}]+)\}/g;

/** Rewrites `${#Project#<name>}` to `${<name>}` in `text` for every `<name>` in `names`. Leaves everything else, including unrecognized `${...}` expressions, byte-identical. */
function rewrite(text: string, names: ReadonlySet<string>): string {
  return text.replace(PROJECT_REF, (whole, name: string) => (names.has(name) ? `\${${name}}` : whole));
}

function rewriteOptional(text: string | undefined, names: ReadonlySet<string>): string | undefined {
  return text === undefined ? undefined : rewrite(text, names);
}

function rewriteCall(call: LegacyCall, names: ReadonlySet<string>): LegacyCall {
  const endpoint = rewriteOptional(call.endpoint, names);
  const envelope = rewriteOptional(call.envelope, names);
  const username = rewriteOptional(call.credentials.username, names);
  if (endpoint === call.endpoint && envelope === call.envelope && username === call.credentials.username) {
    return call;
  }
  return {
    ...call,
    ...(endpoint !== undefined ? { endpoint } : {}),
    ...(envelope !== undefined ? { envelope } : {}),
    credentials:
      username === call.credentials.username || username === undefined
        ? call.credentials
        : { ...call.credentials, username },
  };
}

function rewriteOperation(operation: LegacyOperation, names: ReadonlySet<string>): LegacyOperation {
  const calls = operation.calls.map((call) => rewriteCall(call, names));
  if (calls.every((call, index) => call === operation.calls[index])) {
    return operation;
  }
  return { ...operation, calls };
}

function rewriteInterface(iface: LegacyInterface, names: ReadonlySet<string>): LegacyInterface {
  const endpoints = iface.endpoints.map((url) => rewrite(url, names));
  const operations = iface.operations.map((operation) => rewriteOperation(operation, names));
  const endpointsChanged = endpoints.some((url, index) => url !== iface.endpoints[index]);
  const operationsChanged = operations.some((operation, index) => operation !== iface.operations[index]);
  if (!endpointsChanged && !operationsChanged) {
    return iface;
  }
  return { ...iface, ...(endpointsChanged ? { endpoints } : {}), ...(operationsChanged ? { operations } : {}) };
}

function rewriteProperty(property: LegacyProperty, names: ReadonlySet<string>): LegacyProperty {
  const value = rewrite(property.value, names);
  return value === property.value ? property : { ...property, value };
}

function rewriteEnvironment(env: LegacyEnvironment, names: ReadonlySet<string>): LegacyEnvironment {
  const properties = env.properties.map((property) => rewriteProperty(property, names));
  const endpoints = env.endpoints.map((override) => {
    const url = rewrite(override.url, names);
    return url === override.url ? override : { ...override, url };
  });
  const propertiesChanged = properties.some((property, index) => property !== env.properties[index]);
  const endpointsChanged = endpoints.some((override, index) => override !== env.endpoints[index]);
  if (!propertiesChanged && !endpointsChanged) {
    return env;
  }
  return {
    ...env,
    ...(propertiesChanged ? { properties } : {}),
    ...(endpointsChanged ? { endpoints } : {}),
  };
}

/**
 * Rewrites every `${#Project#<name>}` reference to `${<name>}` throughout `project`, for every
 * `<name>` that at least one imported environment defines as a property. Returns `project` itself
 * (same object) when there is nothing to rewrite, e.g. a project with no environments.
 */
export function rewriteProjectRefsToEnv(project: LegacyProject): LegacyProject {
  const names = new Set<string>();
  for (const env of project.environments) {
    for (const property of env.properties) {
      names.add(property.name);
    }
  }
  if (names.size === 0) {
    return project;
  }

  const interfaces = project.interfaces.map((iface) => rewriteInterface(iface, names));
  const environments = project.environments.map((env) => rewriteEnvironment(env, names));
  const properties = project.properties.map((property) => rewriteProperty(property, names));

  const interfacesChanged = interfaces.some((iface, index) => iface !== project.interfaces[index]);
  const environmentsChanged = environments.some((env, index) => env !== project.environments[index]);
  const propertiesChanged = properties.some((property, index) => property !== project.properties[index]);
  if (!interfacesChanged && !environmentsChanged && !propertiesChanged) {
    return project;
  }

  return {
    ...project,
    ...(interfacesChanged ? { interfaces } : {}),
    ...(environmentsChanged ? { environments } : {}),
    ...(propertiesChanged ? { properties } : {}),
  };
}
