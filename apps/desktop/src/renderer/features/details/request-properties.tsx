import {
  BooleanSetting,
  EnumSetting,
  NumberSetting,
  SettingsGroup,
  TextSetting,
} from '../../components/settings-grid.js';
import { ipc } from '../../state/ipc-client.js';
import { useProjectStore } from '../../state/project.js';
import { selectRequestEndpointUrl } from '../../state/project-endpoint.js';
import type { RequestPropertiesPatchWire } from '../../../shared/wire-types.js';

export interface RequestPropertiesProps {
  readonly requestId: string;
}

/** Shown on the attachment flags, which are stored and editable but not yet honoured by a send. */
const ATTACHMENTS_HINT = 'Stored now; takes effect when attachments and MTOM land (Task 32).';

/**
 * The per-request property grid of the Details panel — SoapUI's request property list, in three
 * groups: the general transport and envelope knobs, the attachment/MTOM flags, and the
 * WS-Security defaults.
 *
 * An empty numeric field means "inherit": the timeout falls back to the project's default and
 * then to the HTTP preference, and Max Size falls back to unlimited. That is why the numeric
 * rows commit `undefined` rather than `0` when cleared.
 */
export function RequestProperties({ requestId }: RequestPropertiesProps) {
  const request = useProjectStore((state) => state.requests[requestId]);
  const endpoint = useProjectStore((state) => selectRequestEndpointUrl(state, requestId));
  const updateRequest = useProjectStore((state) => state.updateRequest);
  const updateRequestProperties = useProjectStore((state) => state.updateRequestProperties);

  if (request === undefined) {
    return <p className="text-md text-fg-muted">This request is no longer in the project.</p>;
  }

  const properties = request.properties;
  const patch = (next: RequestPropertiesPatchWire): void => {
    updateRequestProperties(requestId, next);
  };

  const pickDumpFile = async (): Promise<void> => {
    const result = await ipc().dialogs.saveFile({
      title: 'Dump responses to…',
      ...(properties.dumpFile !== undefined ? { defaultPath: properties.dumpFile } : {}),
    });
    if (result.ok && result.value.path !== undefined) {
      patch({ dumpFile: result.value.path });
    }
  };

  return (
    <div data-testid="request-properties">
      <SettingsGroup title="General">
        <TextSetting
          label="Request name"
          value={request.name}
          onCommit={(name) => {
            if (name.trim().length > 0) {
              updateRequest(requestId, { name: name.trim() });
            }
          }}
        />
        <TextSetting
          label="Description"
          value={request.description ?? ''}
          onCommit={(description) => {
            updateRequest(requestId, { description: description.length > 0 ? description : null });
          }}
        />
        <TextSetting label="Endpoint URL" value={endpoint ?? ''} readOnly monospace onCommit={() => undefined} />
        <TextSetting label="Encoding" value={properties.encoding} onCommit={(encoding) => patch({ encoding })} />
        <NumberSetting
          label="Timeout (ms)"
          value={properties.timeoutMs}
          min={0}
          placeholder="project default"
          testId="request-timeout"
          onCommit={(timeoutMs) => patch({ timeoutMs: timeoutMs ?? null })}
        />
        <TextSetting
          label="Bind address"
          value={properties.bindAddress ?? ''}
          placeholder="any interface"
          onCommit={(bindAddress) => patch({ bindAddress: bindAddress.length > 0 ? bindAddress : null })}
        />
        <BooleanSetting
          label="Follow redirects"
          value={properties.followRedirects}
          onChange={(followRedirects) => patch({ followRedirects })}
        />
        <BooleanSetting
          label="Skip SOAP action"
          value={properties.skipSoapAction}
          onChange={(skipSoapAction) => patch({ skipSoapAction })}
        />
        <NumberSetting
          label="Max size (bytes)"
          value={properties.maxSizeBytes}
          min={0}
          placeholder="unlimited"
          onCommit={(maxSizeBytes) => patch({ maxSizeBytes: maxSizeBytes ?? null })}
        />
        <div className="flex items-end gap-2">
          <div className="min-w-0 flex-1">
            <TextSetting
              label="Dump file"
              value={properties.dumpFile ?? ''}
              monospace
              placeholder="no dump"
              onCommit={(dumpFile) => patch({ dumpFile: dumpFile.length > 0 ? dumpFile : null })}
            />
          </div>
          <button
            type="button"
            className="mb-0.5 h-row shrink-0 rounded-md border border-hairline-strong bg-surface-raised px-2 text-sm text-fg-default hover:bg-surface-hover"
            onClick={() => {
              void pickDumpFile();
            }}
          >
            Browse…
          </button>
        </div>
        <BooleanSetting
          label="Pretty print"
          value={properties.prettyPrint}
          onChange={(prettyPrint) => patch({ prettyPrint })}
        />
        <BooleanSetting
          label="Strip whitespaces"
          value={properties.stripWhitespaces}
          onChange={(stripWhitespaces) => patch({ stripWhitespaces })}
        />
        <BooleanSetting
          label="Remove empty content"
          value={properties.removeEmptyContent}
          onChange={(removeEmptyContent) => patch({ removeEmptyContent })}
        />
        <BooleanSetting
          label="Entitize properties"
          value={properties.entitizeProperties}
          onChange={(entitizeProperties) => patch({ entitizeProperties })}
        />
      </SettingsGroup>

      <SettingsGroup title="Attachments" hint={ATTACHMENTS_HINT}>
        <BooleanSetting label="Enable MTOM" value={properties.enableMtom} onChange={(v) => patch({ enableMtom: v })} />
        <BooleanSetting label="Force MTOM" value={properties.forceMtom} onChange={(v) => patch({ forceMtom: v })} />
        <BooleanSetting
          label="Inline response attachments"
          value={properties.inlineResponseAttachments}
          onChange={(v) => patch({ inlineResponseAttachments: v })}
        />
        <BooleanSetting
          label="Expand MTOM attachments"
          value={properties.expandMtomAttachments}
          onChange={(v) => patch({ expandMtomAttachments: v })}
        />
        <BooleanSetting
          label="Disable multiparts"
          value={properties.disableMultiparts}
          onChange={(v) => patch({ disableMultiparts: v })}
        />
        <BooleanSetting
          label="Encode attachments"
          value={properties.encodeAttachments}
          onChange={(v) => patch({ encodeAttachments: v })}
        />
        <BooleanSetting
          label="Enable inline files"
          value={properties.enableInlineFiles}
          onChange={(v) => patch({ enableInlineFiles: v })}
        />
      </SettingsGroup>

      <SettingsGroup title="WS-Security">
        <EnumSetting
          label="WSS password type"
          value={properties.wssPasswordType ?? ''}
          options={[
            { value: '', label: 'None' },
            { value: 'text', label: 'PasswordText' },
            { value: 'digest', label: 'PasswordDigest' },
          ]}
          onChange={(value) => patch({ wssPasswordType: value === 'text' || value === 'digest' ? value : null })}
        />
        <NumberSetting
          label="WSS time to live (s)"
          value={properties.wssTimeToLive}
          min={0}
          placeholder="none"
          onCommit={(wssTimeToLive) => patch({ wssTimeToLive: wssTimeToLive ?? null })}
        />
      </SettingsGroup>
    </div>
  );
}
