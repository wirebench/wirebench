/**
 * What a sequence step's request is, as the step list and the Add-step picker show it: its name, a
 * protocol badge, the path to it, and whether a run can send it. Mirrors the engine's
 * `findStepRequest`: a WebSocket request, a streaming gRPC call and an orphaned request cannot be
 * steps, and an id that is gone is a missing request.
 */
import type { useProjectStore } from '../../state/project.js';

type ProjectState = ReturnType<typeof useProjectStore.getState>;

/** One request, as a step shows it. */
export interface StepRequestInfo {
  readonly requestId: string;
  readonly name: string;
  /** `POST`, `SOAP`, `gRPC`, `WS`. */
  readonly badge: string;
  /** Where it lives: the interface and operation, or the API. */
  readonly path: string;
  /** Why a run cannot send it; absent when it can. */
  readonly unsupported?: string;
}

/** The request `requestId` names, or `undefined` when it is gone. */
export function stepRequestInfo(state: ProjectState, requestId: string): StepRequestInfo | undefined {
  const soap = state.requests[requestId];
  if (soap !== undefined) {
    const iface = state.interfaces[soap.interfaceId];
    return {
      requestId,
      name: soap.name,
      badge: 'SOAP',
      path: `${iface?.name ?? ''}/${soap.operationName}`,
      ...(soap.orphaned === true ? { unsupported: 'This request is no longer in its contract' } : {}),
    };
  }
  const rest = state.restRequests[requestId];
  if (rest !== undefined) {
    return {
      requestId,
      name: rest.name,
      badge: rest.method,
      path: state.apis[rest.apiId]?.name ?? '',
      ...(rest.orphaned === true ? { unsupported: 'This request is no longer in its contract' } : {}),
    };
  }
  const grpc = state.grpcRequests[requestId];
  if (grpc !== undefined) {
    return {
      requestId,
      name: grpc.name,
      badge: 'gRPC',
      path: `${state.grpcApis[grpc.apiId]?.name ?? ''}/${grpc.service}/${grpc.method}`,
      ...(grpc.methodKind !== 'unary'
        ? { unsupported: 'A streaming gRPC call cannot be a step; only unary calls can' }
        : grpc.orphaned === true
          ? { unsupported: 'This request is no longer in its contract' }
          : {}),
    };
  }
  const ws = state.wsRequests[requestId];
  if (ws !== undefined) {
    return {
      requestId,
      name: ws.name,
      badge: 'WS',
      path: state.wsApis[ws.apiId]?.name ?? '',
      unsupported: 'A WebSocket request cannot be a step',
    };
  }
  return undefined;
}

/** Every request of `projectId` a step could name, runnable ones first, in a stable order. */
export function projectStepRequests(state: ProjectState, projectId: string): StepRequestInfo[] {
  const ids = [
    ...Object.keys(state.requests),
    ...Object.keys(state.restRequests),
    ...Object.keys(state.grpcRequests),
    ...Object.keys(state.wsRequests),
  ].filter((id) => state.projectOf[id] === projectId);
  return ids
    .map((id) => stepRequestInfo(state, id))
    .filter((info): info is StepRequestInfo => info !== undefined)
    .sort(
      (a, b) =>
        Number(a.unsupported !== undefined) - Number(b.unsupported !== undefined) ||
        a.path.localeCompare(b.path) ||
        a.name.localeCompare(b.name),
    );
}
