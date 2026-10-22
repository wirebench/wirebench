/**
 * Which endpoint a SOAP request goes to, and which one its credentials come from. The ladder is the
 * environments' (`project/environments.ts`): an active environment's override for the interface wins
 * over everything else, including a request's own custom URL; then the request's custom URL; then
 * its chosen endpoint; then the interface default; then the interface's first endpoint.
 */
import type { EndpointSource } from '#core/project/environments';
import { findEnvironment } from '#core/project/environments';
import type { Project } from '#core/project/model';
import type { Endpoint, Interface, SoapRequestDef } from './model.js';

/**
 * Resolves the URL a request should actually be sent to, given an optional
 * active environment. See the module doc for the precedence order.
 *
 * `endpoint` is the `Endpoint` object the URL came from, when one exists — the environment
 * override and a request's custom URL name no endpoint, so they carry none. Callers that need
 * the endpoint's own settings (its `trustInvalid` flag, say) read it from here rather than
 * re-deriving the precedence.
 */
export function resolveEndpoint(
  project: Project,
  envId: string | undefined,
  iface: Interface,
  request: Pick<SoapRequestDef, 'endpointId' | 'endpointUrl'>,
): { url: string | undefined; source: EndpointSource; endpoint?: Endpoint } {
  const environment = findEnvironment(project, envId);
  if (environment !== undefined) {
    const override = environment.endpoints[iface.slug];
    if (override !== undefined) {
      return { url: override, source: 'environment' };
    }
  }

  if (request.endpointUrl !== undefined) {
    return { url: request.endpointUrl, source: 'request-custom' };
  }

  if (request.endpointId !== undefined) {
    const endpoint = iface.endpoints.find((candidate) => candidate.id === request.endpointId);
    if (endpoint !== undefined) {
      return { url: endpoint.url, source: 'request-endpoint', endpoint };
    }
  }

  if (iface.defaultEndpointId !== undefined) {
    const endpoint = iface.endpoints.find((candidate) => candidate.id === iface.defaultEndpointId);
    if (endpoint !== undefined) {
      return { url: endpoint.url, source: 'interface-default', endpoint };
    }
  }

  const first = iface.endpoints[0];
  if (first !== undefined) {
    return { url: first.url, source: 'interface-default', endpoint: first };
  }

  return { url: undefined, source: 'none' };
}

/**
 * Resolves the `Endpoint` object a request's *credentials* should come from: the request's own
 * chosen endpoint, else the interface's default, else its first endpoint — the same precedence
 * {@link resolveEndpoint} uses for the URL (minus the environment-override and custom-URL cases,
 * which name no `Endpoint` object of their own, so have no auth to contribute). Callers that need
 * a request's effective auth (not just its URL) should resolve the endpoint through this function
 * rather than re-deriving the precedence, so the two cannot drift apart.
 */
export function resolveAuthEndpoint(
  iface: Interface,
  request: Pick<SoapRequestDef, 'endpointId'>,
): Endpoint | undefined {
  if (request.endpointId !== undefined) {
    const endpoint = iface.endpoints.find((candidate) => candidate.id === request.endpointId);
    if (endpoint !== undefined) {
      return endpoint;
    }
  }
  if (iface.defaultEndpointId !== undefined) {
    const endpoint = iface.endpoints.find((candidate) => candidate.id === iface.defaultEndpointId);
    if (endpoint !== undefined) {
      return endpoint;
    }
  }
  return iface.endpoints[0];
}
