/**
 * The MCP request's own settings (#79): the session's one deadline. An absent value inherits the
 * server's, and the server's absent value the default, so an empty field shows what it falls to.
 */
import { NumberSetting, SettingsGroup } from '../../components/settings-grid.js';
import type { McpRequestPatchWire, McpRequestSettingsWire } from '@shared/kinds/mcp/wire.js';

export interface McpSettingsTabProps {
  readonly settings: McpRequestSettingsWire;
  /** The server's own timeout; absent when it sets none either. */
  readonly serverTimeoutMs: number | undefined;
  readonly onChange: (patch: McpRequestPatchWire) => void;
}

/** The Settings tab. */
export function McpSettingsTab({ settings, serverTimeoutMs, onChange }: McpSettingsTabProps) {
  return (
    <div data-testid="mcp-settings" className="overflow-auto p-3">
      <SettingsGroup title="Session" hint="An empty field inherits the server’s setting.">
        <NumberSetting
          label="Timeout"
          testId="mcp-setting-timeout"
          unit="ms"
          min={1}
          integer
          placeholder={serverTimeoutMs === undefined ? 'Server default' : String(serverTimeoutMs)}
          value={settings.timeoutMs}
          hint={`One deadline for the whole session: connect, initialize and the operation. Inherited: ${
            serverTimeoutMs === undefined ? 'the server’s default' : `${String(serverTimeoutMs)} ms from the server`
          }.`}
          onCommit={(timeoutMs) => {
            // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructured only to omit it
            const { timeoutMs: _dropped, ...rest } = settings;
            onChange({ settings: timeoutMs === undefined ? rest : { ...rest, timeoutMs } });
          }}
        />
      </SettingsGroup>
    </div>
  );
}
