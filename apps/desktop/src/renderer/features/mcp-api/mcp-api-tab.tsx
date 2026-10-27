/**
 * An MCP server's tab (#79): its name, how a session reaches it, its settings, and the catalogue of
 * its last refresh. Every edit is one `update-mcp-server` patch through the project store, as the
 * WebSocket API tab's are, so the project goes dirty and saves the same way. Loaded lazily.
 */
import { NumberSetting, SettingsGroup, TextSetting } from '../../components/settings-grid.js';
import { PagePath } from '../explorer/page-path.js';
import { SettingsPageTabs } from '../../components/settings-page-tabs.js';
import { useProjectStore } from '../../state/project.js';
import type { McpServerPatchWire } from '@shared/kinds/mcp/wire.js';
import { CatalogueSection } from './catalogue-section.js';
import { ConnectionSection } from './connection-section.js';

export interface McpApiTabProps {
  readonly apiId: string;
}

export function McpApiTab({ apiId }: McpApiTabProps) {
  const server = useProjectStore((state) => state.mcpServers[apiId]);
  const updateMcpServer = useProjectStore((state) => state.updateMcpServer);

  if (server === undefined) {
    return <p className="p-4 text-sm text-fg-subtle">This MCP server is no longer in the project.</p>;
  }

  const patch = (changes: McpServerPatchWire): void => {
    void updateMcpServer(apiId, changes);
  };
  const { settings } = server;

  return (
    <section aria-label={`MCP server ${server.name}`} data-testid="mcp-api-tab" className="h-full min-h-0">
      <SettingsPageTabs
        pageId={apiId}
        label="MCP server settings"
        header={<PagePath apiId={apiId} />}
        tabs={[
          {
            id: 'general',
            label: 'General',
            content: (
              <SettingsGroup>
                <TextSetting
                  label="Name"
                  testId="mcp-api-name"
                  value={server.name}
                  onCommit={(name) => {
                    if (name.trim().length > 0) {
                      patch({ name: name.trim() });
                    }
                  }}
                />
                <TextSetting
                  label="Description"
                  testId="mcp-api-description"
                  value={server.description ?? ''}
                  onCommit={(description) => {
                    patch({ description: description === '' ? null : description });
                  }}
                />
              </SettingsGroup>
            ),
          },
          {
            id: 'connection',
            label: 'Connection',
            content: (
              <ConnectionSection
                apiId={apiId}
                transport={server.transport}
                onChange={(transport) => {
                  patch({ transport });
                }}
              />
            ),
          },
          {
            id: 'settings',
            label: 'Settings',
            content: (
              <SettingsGroup hint="Every request on this server uses these unless it says otherwise.">
                <NumberSetting
                  label="Timeout"
                  testId="mcp-api-timeout"
                  unit="ms"
                  min={1}
                  placeholder="Default"
                  value={settings.timeoutMs}
                  onCommit={(timeoutMs) => {
                    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructured only to omit it
                    const { timeoutMs: _dropped, ...rest } = settings;
                    patch({ settings: timeoutMs === undefined ? rest : { ...rest, timeoutMs } });
                  }}
                />
                <TextSetting
                  label="Protocol version"
                  testId="mcp-api-protocol-version"
                  monospace
                  trim
                  placeholder="The newest this build speaks"
                  value={settings.protocolVersion ?? ''}
                  onCommit={(protocolVersion) => {
                    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructured only to omit it
                    const { protocolVersion: _dropped, ...rest } = settings;
                    patch({ settings: protocolVersion === '' ? rest : { ...rest, protocolVersion } });
                  }}
                />
              </SettingsGroup>
            ),
          },
          {
            id: 'catalogue',
            label: 'Catalogue',
            content: (
              <CatalogueSection
                apiId={apiId}
                name={server.name}
                info={server.catalogueInfo}
                catalogue={server.catalogue}
              />
            ),
          },
        ]}
      />
    </section>
  );
}
