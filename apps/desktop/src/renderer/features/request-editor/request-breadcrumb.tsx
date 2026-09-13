import { Fragment, useState } from 'react';
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
  const projectName = useProjectStore((state) => {
    const projectId = state.projectOf[requestId];
    return projectId === undefined ? undefined : state.projects[projectId]?.name;
  });
  const interfaceName = useProjectStore((state) =>
    draft === undefined ? undefined : state.interfaces[draft.interfaceId]?.name,
  );
  const [editing, setEditing] = useState(false);

  if (draft === undefined) {
    return null;
  }

  const trail = [projectName, interfaceName, draft.operationName].filter(
    (segment): segment is string => segment !== undefined && segment.length > 0,
  );

  const soapAction = draft.soapAction !== undefined && draft.soapAction.length > 0 ? draft.soapAction : 'no SOAPAction';

  const commit = (value: string): void => {
    setEditing(false);
    const name = value.trim();
    if (name.length > 0 && name !== draft.name) {
      useProjectStore.getState().updateRequest(requestId, { name });
    }
  };

  return (
    <nav
      aria-label="Request path"
      data-testid="request-breadcrumb"
      className="flex h-8 shrink-0 items-center gap-3 px-3"
    >
      <ol className="flex min-w-0 flex-1 items-center gap-1.5 text-sm">
        {trail.map((segment, index) => (
          <Fragment key={index}>
            <li className="min-w-0 truncate text-fg-subtle" title={segment}>
              {segment}
            </li>
            <li aria-hidden="true" className="shrink-0 text-fg-faint">
              /
            </li>
          </Fragment>
        ))}
        <li aria-current="page" className="min-w-0 font-medium text-fg-default">
          {editing ? (
            <input
              autoFocus
              aria-label="Request name"
              data-testid="request-breadcrumb-name-input"
              defaultValue={draft.name}
              onFocus={(event) => {
                event.currentTarget.select();
              }}
              onBlur={(event) => {
                commit(event.currentTarget.value);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  commit(event.currentTarget.value);
                } else if (event.key === 'Escape') {
                  // Stop here: Escape must not also reach the editor's cancel-send handler.
                  event.preventDefault();
                  event.stopPropagation();
                  setEditing(false);
                }
              }}
              className="w-64 max-w-full rounded bg-surface-base px-1 text-sm outline-none ring-1 ring-accent"
            />
          ) : (
            <span
              data-testid="request-breadcrumb-name"
              title="Double-click to rename"
              className="block cursor-text truncate"
              onDoubleClick={() => {
                setEditing(true);
              }}
            >
              {draft.name}
            </span>
          )}
        </li>
      </ol>
      <span
        data-testid="request-operation"
        title={`${draft.operationName} · SOAPAction: ${soapAction}`}
        className="shrink-0 rounded-sm border border-hairline px-1 text-xs text-fg-muted"
      >
        SOAP {draft.soapVersion}
      </span>
    </nav>
  );
}
