/**
 * The ids a SOAP interface holds, and the interface with each passed through a mapping: what a copy
 * of a project that takes fresh ids (`reidentifyProject`) asks SOAP's storage for.
 */
import { defaultContentId } from './model.js';
import type { Attachment, Interface, SoapRequestDef } from './model.js';

/** Every entity id in `iface`, in visit order: its own, its endpoints', then each request's and its attachments'. */
export function interfaceIds(iface: Interface): readonly string[] {
  const ids = [iface.id, ...iface.endpoints.map((endpoint) => endpoint.id)];
  for (const operation of iface.operations) {
    for (const request of operation.requests) {
      ids.push(request.id, ...request.attachments.map((attachment) => attachment.id));
    }
  }
  return ids;
}

/** `{ [key]: value }` when `value` is defined, `{}` otherwise — keeps an omitted optional field omitted. */
function optional<K extends string>(key: K, value: string | undefined): { [P in K]?: string } {
  return value === undefined ? {} : ({ [key]: value } as { [P in K]?: string });
}

/**
 * `iface` with every id passed through `mapId`, and every reference to one: a request's endpoint,
 * WS-Security configurations and keystore. An attachment whose Content-ID was its id's default
 * takes the new id's default.
 */
export function withInterfaceIds(iface: Interface, mapId: (id: string) => string): Interface {
  const mapRef = (id: string | undefined): string | undefined => (id === undefined ? undefined : mapId(id));
  const attachment = (item: Attachment): Attachment => {
    const id = mapId(item.id);
    const hadDefaultContentId = item.contentId === defaultContentId(item.id);
    return { ...item, id, contentId: hadDefaultContentId ? defaultContentId(id) : item.contentId };
  };
  const request = (item: SoapRequestDef): SoapRequestDef => ({
    ...item,
    id: mapId(item.id),
    ...optional('endpointId', mapRef(item.endpointId)),
    ...optional('wssOutgoingRef', mapRef(item.wssOutgoingRef)),
    ...optional('wssIncomingRef', mapRef(item.wssIncomingRef)),
    attachments: item.attachments.map(attachment),
    properties: { ...item.properties, ...optional('sslKeystoreRef', mapRef(item.properties.sslKeystoreRef)) },
  });
  return {
    ...iface,
    id: mapId(iface.id),
    endpoints: iface.endpoints.map((endpoint) => ({ ...endpoint, id: mapId(endpoint.id) })),
    ...optional('defaultEndpointId', mapRef(iface.defaultEndpointId)),
    operations: iface.operations.map((operation) => ({ ...operation, requests: operation.requests.map(request) })),
  };
}
