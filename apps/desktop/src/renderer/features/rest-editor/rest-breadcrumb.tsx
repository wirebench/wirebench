/**
 * Where the open REST request lives: Project / API / folder… / Request, with its method at the far
 * right. The same line the SOAP editor shows, with this protocol's path and badge.
 */
import { Breadcrumb } from '../../components/breadcrumb.js';
import { useProjectStore } from '../../state/project.js';
import { requestLocation, useRequestTrail } from '../explorer/request-trail.js';
import { MethodBadge } from '../rest-api/method-badge.js';

export interface RestBreadcrumbProps {
  readonly requestId: string;
}

/** The path line for one REST request. */
export function RestBreadcrumb({ requestId }: RestBreadcrumbProps) {
  const request = useProjectStore((state) => state.restRequests[requestId]);
  const projectId = useProjectStore((state) => state.projectOf[requestId]);
  // Each part opens its tab and shows its row in the Explorer.
  const trail = useRequestTrail(requestLocation(request, projectId));

  if (request === undefined) {
    return null;
  }

  return (
    <Breadcrumb
      label="Request path"
      testidPrefix="rest-breadcrumb"
      trail={trail}
      name={request.name}
      onRename={(name) => {
        void useProjectStore.getState().updateRestRequest(requestId, { name });
      }}
      badge={<MethodBadge method={request.method} className="w-auto" />}
    />
  );
}
