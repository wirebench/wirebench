/**
 * Where the open gRPC request lives: Project / API / folder… / Request, with its streaming shape
 * at the far right. The same line the REST editor shows, with this protocol's path and badge.
 */
import { useMemo } from 'react';
import { Breadcrumb } from '../../components/breadcrumb.js';
import { folderChainOf, useProjectStore } from '../../state/project.js';
import { MethodKindBadge } from './method-kind-badge.js';

export interface GrpcBreadcrumbProps {
  readonly requestId: string;
}

/** The path line for one gRPC request. */
export function GrpcBreadcrumb({ requestId }: GrpcBreadcrumbProps) {
  const request = useProjectStore((state) => state.grpcRequests[requestId]);
  const projectName = useProjectStore((state) => {
    const projectId = state.projectOf[requestId];
    return projectId === undefined ? undefined : state.projects[projectId]?.name;
  });
  const apiName = useProjectStore((state) => (request === undefined ? undefined : state.grpcApis[request.apiId]?.name));
  const folderMap = useProjectStore((state) => state.folders);
  const folders = useMemo(() => folderChainOf(folderMap, request?.folderId), [folderMap, request?.folderId]);

  if (request === undefined) {
    return null;
  }

  const trail = [projectName, apiName, ...folders.map((folder) => folder.name)].filter(
    (segment): segment is string => segment !== undefined && segment.length > 0,
  );

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
