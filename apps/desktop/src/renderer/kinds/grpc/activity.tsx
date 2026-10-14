import { openGrpcRequestTab } from '../../features/grpc-editor/grpc-actions.js';
import { ipc } from '../../state/ipc-client.js';
import type { KindHistory, KindLog, KindRequests, KindSearch } from '../renderer-kind.js';

export const grpcRequests: KindRequests = {
  open: openGrpcRequestTab,
  exists: (requestId, project) => project.grpcRequests[requestId] !== undefined,
  quickOpen: (project) =>
    Object.values(project.grpcRequests).map((request) => ({
      id: request.id,
      tag: 'gRPC',
      name: request.name,
      apiId: request.apiId,
      apiName: project.grpcApis[request.apiId]?.name ?? 'gRPC API',
      ...(request.folderId !== undefined ? { folderId: request.folderId } : {}),
      match: `${request.service}/${request.method}`,
    })),
};

function GrpcHistoryBadge({ place }: { readonly place: 'row' | 'header' }) {
  return place === 'row' ? (
    <span data-testid="history-grpc-badge" className="w-12 shrink-0 text-fg-faint">
      gRPC
    </span>
  ) : (
    <span className="text-xs text-fg-faint">gRPC</span>
  );
}

export const grpcHistory: KindHistory = {
  Badge: GrpcHistoryBadge,
  canResend: () => true,
  resend: (id) => ipc().history.resendGrpc({ id }),
};

export const grpcSearch: KindSearch = { badge: 'gRPC' };

export const grpcLog: KindLog = {
  resendRefusal: (_entry, requestId, lookup) =>
    lookup.unaryGrpc(requestId) ? undefined : 'Streaming calls resend from the editor',
};
