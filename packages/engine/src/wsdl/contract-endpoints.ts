/**
 * Endpoints made from a WSDL's `soap:address` locations. The address is the contract's text, so a
 * `${…}` in it is escaped as `$${…}` and sent as written: it never reads a property, a secret or
 * the sending process's environment (#223). Import, Update Definition and the request's endpoint
 * menu all make endpoints here, so they cannot drift apart.
 *
 * The renderer's endpoint menu never imports this: main sends each port's escaped URL with the
 * interface summary (`endpointUrl`), so the menu commits what this helper made.
 */

import type { Endpoint } from '../soap/model.js';
import { escapeExpansions } from '../project/escape-expansions.js';
import type { WsdlDefinition } from './model.js';

/** One `wsdl:port` of a service, as an endpoint is named and addressed from it. */
export interface ContractPort {
  readonly service: string;
  readonly port: string;
  readonly address?: string;
}

/** The URL an endpoint holds for a contract's `soap:address`: its `${` escaped as `$${`. */
export function endpointUrlFromContract(address: string): string {
  return escapeExpansions(address);
}

/** Every port of every service of `definition`, in document order. */
export function contractPorts(definition: WsdlDefinition): ContractPort[] {
  return definition.services.flatMap((service) =>
    service.ports.map((port) => ({
      service: service.name.localName,
      port: port.name,
      ...(port.address !== undefined ? { address: port.address } : {}),
    })),
  );
}

/** One endpoint per distinct address of `ports`, in order, its URL from {@link endpointUrlFromContract}. */
export function endpointsFromContract(ports: Iterable<ContractPort>, newId: () => string): Endpoint[] {
  const seen = new Set<string>();
  const endpoints: Endpoint[] = [];
  for (const { service, port, address } of ports) {
    if (address === undefined) {
      continue;
    }
    const url = endpointUrlFromContract(address);
    if (seen.has(url)) {
      continue;
    }
    seen.add(url);
    endpoints.push({ id: newId(), name: `${service} ${port}`, url, authMode: 'complement' });
  }
  return endpoints;
}
