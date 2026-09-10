import { BooleanSetting, ReadOnlySetting, SettingsGroup, TextSetting } from '../../components/settings-grid.js';
import { useProjectStore } from '../../state/project.js';

export interface InterfacePropertiesProps {
  readonly interfaceId: string;
}

/**
 * The interface row's inspector. Everything but the definition cache is derived from the WSDL
 * and therefore read-only: renaming an interface would mean renaming its folder, and its
 * target namespace and WS-A version come from the definition itself.
 */
export function InterfaceProperties({ interfaceId }: InterfacePropertiesProps) {
  const iface = useProjectStore((state) => state.interfaces[interfaceId]);
  const setCacheDefinition = useProjectStore((state) => state.setCacheDefinition);

  if (iface === undefined) {
    return <p className="text-md text-fg-muted">This interface is no longer in the project.</p>;
  }

  return (
    <div data-testid="interface-properties">
      <SettingsGroup title="Interface">
        <TextSetting label="Name" value={iface.name} readOnly onCommit={() => undefined} />
        <TextSetting label="Definition URL" value={iface.definitionUrl} readOnly monospace onCommit={() => undefined} />
        <ReadOnlySetting label="Target namespace" value={iface.targetNamespace ?? '—'} />
        <ReadOnlySetting label="SOAP versions" value={iface.soapVersions.join(', ')} />
        <ReadOnlySetting label="WS-Addressing" value="2005/08 (configured with WS-A)" />
        <BooleanSetting
          label="Cache definition"
          value={iface.cacheDefinition}
          onChange={(cacheDefinition) => {
            void setCacheDefinition(interfaceId, cacheDefinition);
          }}
        />
      </SettingsGroup>
    </div>
  );
}
