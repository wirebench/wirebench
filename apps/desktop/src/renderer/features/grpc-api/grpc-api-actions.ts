/**
 * Opening a gRPC API's tab. The id — `grpc-api:<apiId>` — is fixed here because the explorer, the
 * persisted-tab restore and the store's cleanup all use it.
 */
import { useEditorsStore } from '../../state/editors.js';
import { useProjectStore } from '../../state/project.js';

/** The editor-tab id for one gRPC API. */
export function grpcApiTabId(apiId: string): string {
  return `grpc-api:${apiId}`;
}

/** Opens (or focuses) the gRPC API's tab. An API the mirror does not hold is ignored. */
export function openGrpcApiTab(apiId: string, fallbackTitle?: string): void {
  const title = useProjectStore.getState().grpcApis[apiId]?.name ?? fallbackTitle;
  if (title === undefined) {
    return;
  }
  useEditorsStore.getState().open({ id: grpcApiTabId(apiId), kind: 'grpc-api', title, grpcApiId: apiId });
}
