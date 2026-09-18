/**
 * The HTTP Log's Name column: the saved request a row came from, resolved in the renderer from its
 * `requestId` against the project store. gRPC rows read `Service/Method`, the service shortened to
 * fit the column; a row with no known request falls back to its URL path.
 */
import { useCallback, useMemo } from 'react';
import type { LogEntry } from '../../state/exchanges.js';
import { useProjectStore } from '../../state/project.js';
import { protocolOf, urlOf } from './log-filter.js';

export interface NameSources {
  readonly requests: Readonly<Record<string, { readonly name: string }>>;
  readonly restRequests: Readonly<Record<string, { readonly name: string }>>;
  readonly grpcRequests: Readonly<Record<string, { readonly service: string; readonly method: string }>>;
}

function requestIdOf(entry: LogEntry): string | undefined {
  return entry.kind === 'exchange' ? entry.requestId : entry.failure.requestId;
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

/**
 * The saved request's name (gRPC: Service/Method); the URL path when no request is known. `full`
 * keeps a gRPC service's package (`pets.v1.PetService/GetPet`), for the cell's tooltip.
 */
export function nameOf(entry: LogEntry, sources: NameSources, full = false): string {
  const id = requestIdOf(entry);
  if (id !== undefined) {
    const protocol = protocolOf(entry);
    if (protocol === 'grpc') {
      const request = sources.grpcRequests[id];
      if (request !== undefined) {
        const service = full ? request.service : (request.service.split('.').pop() ?? request.service);
        return `${service}/${request.method}`;
      }
    } else {
      const request = protocol === 'rest' ? sources.restRequests[id] : sources.requests[id];
      if (request !== undefined) {
        return request.name;
      }
    }
  }
  return pathOf(urlOf(entry));
}

/** The three records the name comes from, each selected on its own so other store changes do not rerender. */
export function useNameSources(): NameSources {
  const requests = useProjectStore((state) => state.requests);
  const restRequests = useProjectStore((state) => state.restRequests);
  const grpcRequests = useProjectStore((state) => state.grpcRequests);
  return useMemo(() => ({ requests, restRequests, grpcRequests }), [requests, restRequests, grpcRequests]);
}

/** Memoised over the three records. */
export function useNameOf(): (entry: LogEntry) => string {
  const sources = useNameSources();
  return useCallback((entry: LogEntry) => nameOf(entry, sources), [sources]);
}
