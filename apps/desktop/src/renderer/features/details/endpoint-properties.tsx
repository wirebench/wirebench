import { ReadOnlySetting, SettingsGroup, TextSetting } from '../../components/settings-grid.js';
import { useProjectStore } from '../../state/project.js';

export interface EndpointPropertiesProps {
  readonly interfaceId: string;
  /** The port address the selected explorer node names. */
  readonly address: string;
}

/**
 * The endpoint row's inspector. The explorer's endpoint nodes come from the *definition*'s
 * ports, so the address is the identity here; when a saved project endpoint has the same URL
 * its name is editable, and otherwise the row is simply reported.
 */
export function EndpointProperties({ interfaceId, address }: EndpointPropertiesProps) {
  const iface = useProjectStore((state) => state.interfaces[interfaceId]);
  const updateEndpoint = useProjectStore((state) => state.updateEndpoint);
  const saved = iface?.endpoints.find((candidate) => candidate.url === address);

  return (
    <div data-testid="endpoint-properties">
      <SettingsGroup title="Endpoint">
        {saved === undefined ? (
          <ReadOnlySetting label="Name" value="Not saved as a project endpoint" />
        ) : (
          <TextSetting
            label="Name"
            value={saved.name}
            onCommit={(name) => {
              void updateEndpoint(interfaceId, saved.id, { name });
            }}
          />
        )}
        {saved === undefined ? (
          <ReadOnlySetting label="URL" value={address} />
        ) : (
          <TextSetting
            label="URL"
            value={saved.url}
            monospace
            onCommit={(url) => {
              void updateEndpoint(interfaceId, saved.id, { url });
            }}
          />
        )}
      </SettingsGroup>
    </div>
  );
}
