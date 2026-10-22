/**
 * Which endpoint a SOAP request goes to for a project open inside a workspace: a linked project
 * environment's override for the interface first, then the workspace environment's override keyed
 * `<projectSlug>/<interfaceSlug>`, then whatever `resolveEndpoint` says for the project alone. The
 * same ladder `resolveWorkspaceApiBaseUrl` (`workspace/environments.ts`) climbs for a REST API.
 */
import type { EndpointSource } from '../project/environments.js';
import type { Project } from '../project/model.js';
import { activeWorkspaceEnvironment, linkedEnvironment } from '../workspace/environments.js';
import type { Workspace } from '../workspace/model.js';
import { resolveEndpoint } from './endpoints.js';
import type { Endpoint, Interface, SoapRequestDef } from './model.js';

/**
 * Resolves the URL a request should actually be sent to for a project open inside `workspace`.
 * See the module doc for the precedence order. `endpoint` is present only when the URL came
 * from an `Endpoint` object (i.e. the fallback to {@link resolveEndpoint} landed on
 * `request-endpoint` or `interface-default`) — the two environment-override branches name no
 * `Endpoint`, matching `resolveEndpoint`'s own contract.
 */
export function resolveWorkspaceEndpoint(input: {
  readonly workspace: Workspace;
  readonly project: Project;
  readonly projectSlug: string;
  readonly iface: Interface;
  readonly request: Pick<SoapRequestDef, 'endpointId' | 'endpointUrl'>;
}): { url: string | undefined; source: EndpointSource; endpoint?: Endpoint } {
  const { workspace, project, projectSlug, iface, request } = input;
  const activeWorkspaceEnv = activeWorkspaceEnvironment(workspace);
  const linkedProjectEnv = linkedEnvironment(project, activeWorkspaceEnv);

  if (linkedProjectEnv !== undefined) {
    const override = linkedProjectEnv.endpoints[iface.slug];
    if (override !== undefined) {
      return { url: override, source: 'environment' };
    }
  }

  if (activeWorkspaceEnv !== undefined) {
    const override = activeWorkspaceEnv.endpoints[`${projectSlug}/${iface.slug}`];
    if (override !== undefined) {
      return { url: override, source: 'workspace-environment' };
    }
  }

  return resolveEndpoint(project, undefined, iface, request);
}
