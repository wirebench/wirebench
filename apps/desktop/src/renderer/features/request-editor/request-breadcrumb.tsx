import { Breadcrumb, type TrailSegment } from '../../components/breadcrumb.js';
import { explorerActions } from '../explorer/explorer-actions.js';
import { openProjectTab } from '../explorer/project-actions.js';
import { openAndReveal } from '../explorer/request-trail.js';
import { useProjectStore } from '../../state/project.js';

export interface RequestBreadcrumbProps {
  readonly requestId: string;
}

/**
 * Where the open request lives: Project / Interface / Operation / Request, above the toolbar.
 * Every name is read from the project mirror, so a rename anywhere along the path shows here at
 * once. A segment whose entity the mirror does not hold (yet) is simply left out.
 *
 * The request's own name renames in place on a double-click: Enter or leaving the field keeps
 * the new name, Escape drops it, and a blank or unchanged name changes nothing. The operation's
 * SOAP version sits at the far right, with its SOAPAction on hover.
 */
export function RequestBreadcrumb({ requestId }: RequestBreadcrumbProps) {
  const draft = useProjectStore((state) => state.requests[requestId]);
  const projectId = useProjectStore((state) => state.projectOf[requestId]);
  const projectName = useProjectStore((state) =>
    projectId === undefined ? undefined : state.projects[projectId]?.name,
  );
  const interfaceName = useProjectStore((state) =>
    draft === undefined ? undefined : state.interfaces[draft.interfaceId]?.name,
  );

  if (draft === undefined) {
    return null;
  }

  // Each part opens its tab, or for the operation, which has none, shows its row in the Explorer.
  const { interfaceId, bindingName, operationName } = draft;
  const parts: (TrailSegment | undefined)[] = [
    projectName === undefined || projectId === undefined
      ? undefined
      : { text: projectName, open: openAndReveal(() => openProjectTab(projectId), `proj:${projectId}`) },
    interfaceName === undefined
      ? undefined
      : {
          text: interfaceName,
          open: openAndReveal(() => explorerActions.showInterface(interfaceId), `iface:${interfaceId}`),
        },
    {
      text: operationName,
      open: openAndReveal(() => undefined, `op:${interfaceId}:${bindingName}:${operationName}`),
    },
  ];
  const trail = parts.filter((segment): segment is TrailSegment => segment !== undefined && segment.text.length > 0);

  const soapAction = draft.soapAction !== undefined && draft.soapAction.length > 0 ? draft.soapAction : 'no SOAPAction';

  return (
    <Breadcrumb
      label="Request path"
      testidPrefix="request-breadcrumb"
      trail={trail}
      name={draft.name}
      onRename={(name) => {
        useProjectStore.getState().updateRequest(requestId, { name });
      }}
      badge={
        <span
          data-testid="request-operation"
          title={`${draft.operationName} · SOAPAction: ${soapAction}`}
          className="shrink-0 rounded-sm border border-hairline px-1 text-xs text-fg-muted"
        >
          SOAP {draft.soapVersion}
        </span>
      }
    />
  );
}
