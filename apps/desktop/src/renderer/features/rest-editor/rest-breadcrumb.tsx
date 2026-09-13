/**
 * Where the open REST request lives: Project / API / folder… / Request, with its method at the far
 * right. The same line the SOAP editor shows, with this protocol's path and badge.
 */
import { useMemo } from 'react';
import { Breadcrumb } from '../../components/breadcrumb.js';
import { folderChainOf, useProjectStore } from '../../state/project.js';
import { MethodBadge } from '../rest-api/method-badge.js';

export interface RestBreadcrumbProps {
  readonly requestId: string;
}

/** The path line for one REST request. */
export function RestBreadcrumb({ requestId }: RestBreadcrumbProps) {
  const request = useProjectStore((state) => state.restRequests[requestId]);
  const projectName = useProjectStore((state) => {
    const projectId = state.projectOf[requestId];
    return projectId === undefined ? undefined : state.projects[projectId]?.name;
  });
  const apiName = useProjectStore((state) => (request === undefined ? undefined : state.apis[request.apiId]?.name));
  // The map, then the chain in a memo: the chain is a fresh array, and building one inside a
  // selector would hand React a new reference on every render.
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
      testidPrefix="rest-breadcrumb"
      trail={trail}
      name={request.name}
      onRename={(name) => {
        void useProjectStore.getState().updateRestRequest(requestId, { name });
      }}
      badge={<MethodBadge method={request.method} />}
    />
  );
}
