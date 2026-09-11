import { AuthFields } from '../../components/auth-fields.js';
import { WsaFields } from '../../components/wsa-fields.js';
import { BooleanSetting, ReadOnlySetting, SettingsGroup, TextSetting } from '../../components/settings-grid.js';
import { useProjectStore } from '../../state/project.js';

export interface InterfacePropertiesProps {
  readonly interfaceId: string;
}

/**
 * The interface row's inspector. Everything but the definition cache, the credentials and the
 * WS-Addressing defaults is derived from the WSDL and therefore read-only: renaming an
 * interface would mean renaming its folder, and its target namespace comes from the definition.
 */
export function InterfaceProperties({ interfaceId }: InterfacePropertiesProps) {
  const iface = useProjectStore((state) => state.interfaces[interfaceId]);
  const setCacheDefinition = useProjectStore((state) => state.setCacheDefinition);
  const updateInterfaceAuth = useProjectStore((state) => state.updateInterfaceAuth);
  const updateInterfaceWsa = useProjectStore((state) => state.updateInterfaceWsa);

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
        <BooleanSetting
          label="Cache definition"
          value={iface.cacheDefinition}
          onChange={(cacheDefinition) => {
            void setCacheDefinition(interfaceId, cacheDefinition);
          }}
        />
      </SettingsGroup>
      <SettingsGroup title="Authentication">
        <div className="p-2">
          <p className="mb-2 text-xs text-fg-subtle">
            Used by every request of this interface that configures no credentials of its own.
          </p>
          <AuthFields
            scope="Interface"
            auth={iface.auth}
            onChange={(auth) => {
              void updateInterfaceAuth(interfaceId, auth);
            }}
          />
        </div>
      </SettingsGroup>
      <SettingsGroup title="WS-Addressing">
        <div className="p-2">
          <p className="mb-2 text-xs text-fg-subtle">
            {iface.wsa?.enabled === true
              ? 'This WSDL declares WS-Addressing, so it was enabled on import.'
              : 'Applied to every request of this interface that inherits these defaults.'}
          </p>
          <WsaFields
            config={iface.wsaConfig ?? { enabled: false }}
            testIdPrefix="interface-wsa"
            onChange={(patch) => {
              void updateInterfaceWsa(interfaceId, { ...(iface.wsaConfig ?? { enabled: false }), ...patch });
            }}
          />
        </div>
      </SettingsGroup>
    </div>
  );
}
