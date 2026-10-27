import { ReadOnlySetting, SettingsGroup } from '../../../components/settings-grid.js';
import { useProjectStore } from '../../../state/project.js';
import { selectRequestEndpointSource, selectRequestEndpointUrl } from '../../../state/project-endpoint.js';
import { useWorkspaceStore } from '../../../state/workspace.js';
import type { EndpointSourceWire } from '@shared/kinds/soap/wire.js';

export interface DetailsInspectorProps {
  readonly requestId: string;
}

/** A human label for each {@link EndpointSourceWire} the resolved endpoint can come from. */
const SOURCE_LABEL: Record<EndpointSourceWire, string> = {
  environment: "a linked project's own environment",
  'workspace-environment': 'the active workspace environment',
  'request-custom': "this request's own custom URL",
  'request-endpoint': "this request's chosen endpoint",
  'interface-default': "the interface's default endpoint",
  none: 'nothing — no endpoint resolves',
};

/**
 * The facts about a request that are edited elsewhere: its interface, operation and SOAPAction, the
 * endpoint it resolves to today and which rule produced it, and its project. Properties shows them at
 * its top now that the Details tab is folded into it (#731 X21).
 */
export function RequestFacts({ requestId, title }: DetailsInspectorProps & { readonly title?: string }) {
  const request = useProjectStore((state) => state.requests[requestId]);
  const iface = useProjectStore((state) => (request === undefined ? undefined : state.interfaces[request.interfaceId]));
  const projectId = useProjectStore((state) => state.projectOf[requestId]);
  const projectName = useProjectStore((state) =>
    projectId === undefined ? undefined : state.projects[projectId]?.name,
  );
  // The active environment lives on the workspace, so an environment switch has to rerender
  // the endpoint as well as a project change — same reasoning as the toolbar's own selectors.
  const workspace = useWorkspaceStore((state) => state.workspace);
  const endpoint = useProjectStore((state) => selectRequestEndpointUrl(state, workspace, requestId));
  const endpointSource = useProjectStore((state) => selectRequestEndpointSource(state, workspace, requestId));
  if (request === undefined) return null;
  return (
    <SettingsGroup {...(title !== undefined ? { title } : {})}>
      <ReadOnlySetting label="Interface" value={iface?.name ?? '—'} />
      <ReadOnlySetting label="Operation" value={request.operationName} />
      <ReadOnlySetting
        label="SOAPAction"
        value={request.soapAction !== undefined && request.soapAction.length > 0 ? request.soapAction : '—'}
      />
      <ReadOnlySetting label="Endpoint" value={endpoint ?? '—'} />
      <ReadOnlySetting label="Endpoint source" value={SOURCE_LABEL[endpointSource]} />
      <ReadOnlySetting label="Project" value={projectName ?? '—'} />
    </SettingsGroup>
  );
}

/** The facts on their own, as the Details tab showed them. */
export function DetailsInspector({ requestId }: DetailsInspectorProps) {
  const exists = useProjectStore((state) => state.requests[requestId] !== undefined);
  if (!exists) {
    return <p className="p-3 text-sm text-fg-subtle">This request no longer exists.</p>;
  }
  return (
    <div data-testid="request-details-inspector" className="overflow-auto p-3">
      <RequestFacts requestId={requestId} />
    </div>
  );
}
