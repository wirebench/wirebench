/**
 * The Interface editor's Overview tab: what the WSDL is, where it came from, and how much of it
 * there is. Everything is read from the project mirror and the cached bundle — no fetch of its
 * own, and nothing here is editable (the definition owns these values).
 */

import { Button } from '../../components/button.js';
import { ReadOnlySetting, SettingsGroup } from '../../components/settings-grid.js';
import { useProjectStore } from '../../state/project.js';
import { exportDefinition, generateDocumentation, updateDefinition } from './interface-actions.js';
import { useInterfaceEditorStore } from './interface-editor-state.js';

export interface OverviewTabProps {
  readonly interfaceId: string;
}

/** The distinct binding QNames the interface's operations are bound through, in first-seen order. */
export function bindingsOf(operations: readonly { readonly bindingLocal: string }[]): string[] {
  const seen: string[] = [];
  for (const operation of operations) {
    if (!seen.includes(operation.bindingLocal)) {
      seen.push(operation.bindingLocal);
    }
  }
  return seen;
}

/** A local-time stamp for the last load, or a dash when the bundle has not arrived yet. */
function formatLoadedAt(loadedAt: number | undefined): string {
  return loadedAt === undefined || loadedAt === 0 ? '—' : new Date(loadedAt).toLocaleString();
}

export function OverviewTab({ interfaceId }: OverviewTabProps) {
  const iface = useProjectStore((state) => state.interfaces[interfaceId]);
  const data = useInterfaceEditorStore((state) => state.data[interfaceId]);

  if (iface === undefined) {
    return <p className="p-4 text-md text-fg-muted">This interface is no longer in the project.</p>;
  }

  const documentCount = data?.documents?.documents.length ?? iface.documentCount;

  return (
    <div data-testid="interface-overview" className="h-full overflow-auto p-3">
      <SettingsGroup title="Definition">
        <ReadOnlySetting label="Name" value={iface.name} />
        <ReadOnlySetting label="Definition URL" value={iface.definitionUrl} />
        <ReadOnlySetting label="Target namespace" value={iface.targetNamespace === '' ? '—' : iface.targetNamespace} />
        <ReadOnlySetting label="SOAP versions" value={iface.soapVersions.join(', ')} />
        <ReadOnlySetting
          label="Bindings"
          value={bindingsOf(iface.operations).join(', ') === '' ? '—' : bindingsOf(iface.operations).join(', ')}
        />
      </SettingsGroup>
      <SettingsGroup title="Contents">
        <ReadOnlySetting
          label="Operations"
          value={String(iface.operations.length)}
          testId="interface-operation-count"
        />
        <ReadOnlySetting label="Endpoints" value={String(iface.endpoints.length)} testId="interface-endpoint-count" />
        <ReadOnlySetting label="Documents" value={String(documentCount)} testId="interface-document-count" />
        <ReadOnlySetting label="Problems" value={String(iface.problems.length)} />
      </SettingsGroup>
      <SettingsGroup title="Definition actions">
        <div className="flex flex-wrap gap-2 py-1">
          <Button data-testid="interface-update-definition" onClick={() => updateDefinition(interfaceId)}>
            Update Definition…
          </Button>
          <Button data-testid="interface-export-definition" onClick={() => void exportDefinition(interfaceId)}>
            Export Definition…
          </Button>
          <Button data-testid="interface-generate-docs" onClick={() => generateDocumentation(interfaceId)}>
            Generate Documentation…
          </Button>
        </div>
      </SettingsGroup>
      <SettingsGroup title="Cache">
        <ReadOnlySetting label="Cache definition" value={iface.cacheDefinition ? 'On' : 'Off'} />
        <ReadOnlySetting label="Definition state" value={iface.hydration} />
        <ReadOnlySetting label="Last import" value={formatLoadedAt(data?.documents?.loadedAt)} />
      </SettingsGroup>
    </div>
  );
}
