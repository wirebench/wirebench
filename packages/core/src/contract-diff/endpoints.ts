/**
 * Endpoints moved (#56 spec §3.1): the `soap:address` locations of a WSDL or the `servers` of an
 * OpenAPI document, compared as sets. One removed and one added is a move.
 */
import type { ContractChange } from './model.js';

export function diffEndpoints(oldEndpoints: readonly string[], newEndpoints: readonly string[]): ContractChange[] {
  const removed = [...new Set(oldEndpoints)].filter((endpoint) => !newEndpoints.includes(endpoint));
  const added = [...new Set(newEndpoints)].filter((endpoint) => !oldEndpoints.includes(endpoint));
  const [from] = removed;
  const [to] = added;
  if (removed.length === 1 && added.length === 1 && from !== undefined && to !== undefined) {
    return [{ kind: 'endpoint-moved', severity: 'breaking', message: `endpoint ${from} moved to ${to}` }];
  }
  return [
    ...removed.map((endpoint): ContractChange => ({
      kind: 'endpoint-removed',
      severity: 'breaking',
      message: `endpoint ${endpoint} removed`,
    })),
    ...added.map((endpoint): ContractChange => ({
      kind: 'endpoint-added',
      severity: 'compatible',
      message: `endpoint ${endpoint} added`,
    })),
  ];
}
