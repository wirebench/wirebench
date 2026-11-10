/**
 * Where the open gRPC request lives: Project / API / folder… / Request, with its streaming shape
 * at the far right. The same line the REST editor shows, with this protocol's path and badge.
 */
import { Breadcrumb } from '../../components/breadcrumb.js';
import { useProjectStore } from '../../state/project.js';
import { requestLocation, useRequestTrail } from '../explorer/request-trail.js';
import { MethodKindBadge } from './method-kind-badge.js';

export interface GrpcBreadcrumbProps {
  readonly requestId: string;
}

/** The path line for one gRPC request. */
export function GrpcBreadcrumb({ requestId }: GrpcBreadcrumbProps) {
  const request = useProjectStore((state) => state.grpcRequests[requestId]);
  const projectId = useProjectStore((state) => state.projectOf[requestId]);
  const trail = useRequestTrail(requestLocation(request, projectId));

  if (request === undefined) {
    return null;
  }

  return (
    <Breadcrumb
      label="Request path"
      testidPrefix="grpc-breadcrumb"
      trail={trail}
      name={request.name}
      onRename={(name) => {
        void useProjectStore.getState().updateGrpcRequest(requestId, { name });
      }}
      badge={<MethodKindBadge kind={request.methodKind} />}
    />
  );
}
