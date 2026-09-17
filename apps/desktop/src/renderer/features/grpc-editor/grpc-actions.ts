/**
 * Opening a gRPC request's editor tab. What is fixed here is the tab's id — `grpc:<requestId>` —
 * which the explorer, the commands, the persisted-tab restore and the store's cleanup all address
 * it by.
 */
import { useEditorsStore } from '../../state/editors.js';
import { useProjectStore } from '../../state/project.js';

/** The editor-tab id for one gRPC request. */
export function grpcTabId(requestId: string): string {
  return `grpc:${requestId}`;
}

/** Opens (or focuses) the gRPC request's tab. A request the mirror does not hold is ignored. */
export function openGrpcRequestTab(requestId: string, fallbackTitle?: string): void {
  const title = useProjectStore.getState().grpcRequests[requestId]?.name ?? fallbackTitle;
  if (title === undefined) {
    return;
  }
  useEditorsStore.getState().open({ id: grpcTabId(requestId), kind: 'grpc-request', title, grpcRequestId: requestId });
}
