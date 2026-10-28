import {
  BooleanSetting,
  EnumSetting,
  NumberSetting,
  SettingsGroup,
  TextSetting,
} from '../../../components/settings-grid.js';
import { ipc } from '../../../state/ipc-client.js';
import { useProjectStore } from '../../../state/project.js';
import { RequestFacts } from './details-inspector.js';
import type { RequestPropertiesPatchWire } from '@shared/kinds/soap/wire.js';
import { hasCapability } from '../../../lib/capabilities.js';

export interface PropertiesInspectorProps {
  readonly requestId: string;
}

/** Shown on the SSL Keystore field, which is stored but has no picker yet. */
const SSL_KEYSTORE_HINT = 'The client certificate this request presents. Manage keystores in the WS-Security view.';

/**
 * The `Encoding` property's closed set of choices: every label Node's `Buffer` can encode a
 * request body as, plus `ISO-8859-1` — a valid encoding label that `Buffer` itself does not
 * recognise by that name (`encodeBody` maps it to `latin1` internally, see `send.ts`).
 */
const ENCODING_OPTIONS = [
  { value: 'UTF-8', label: 'UTF-8' },
  { value: 'ASCII', label: 'US-ASCII' },
  { value: 'ISO-8859-1', label: 'ISO-8859-1 (Latin-1)' },
  { value: 'UTF-16LE', label: 'UTF-16LE' },
  { value: 'BASE64', label: 'Base64' },
  { value: 'HEX', label: 'Hex' },
];

/**
 * The request pane's Properties inspector: the per-request property list, in three groups — the
 * general transport and envelope knobs, the attachment/MTOM flags, and the WS-Security defaults.
 *
 * An empty numeric field means "inherit": the timeout falls back to the project's default and
 * then to the HTTP preference, and Max Size falls back to unlimited. That is why the numeric
 * rows commit `undefined` rather than `0` when cleared.
 */
export function PropertiesInspector({ requestId }: PropertiesInspectorProps) {
  const request = useProjectStore((state) => state.requests[requestId]);
  const editRequest = useProjectStore((state) => state.editRequest);
  const updateRequestProperties = useProjectStore((state) => state.updateRequestProperties);
  const keystores = useProjectStore((state) => state.keystores);

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
    <div data-testid="request-properties" className="overflow-auto p-3">
      {/* What the Details tab showed, read-only (#731 X21). The name, the endpoint and WS-A are edited in
          the breadcrumb, the URL bar and the WS-A tab; the attachment flags are under Attachments and
          the WS-Security defaults under Auth (#732 X08). */}
      <RequestFacts requestId={requestId} title="This request" />
      <SettingsGroup title="Sending">
        <TextSetting
          label="Description"
          hint="A note kept with the request; nothing is sent."
          value={request.description ?? ''}
          onCommit={(description) => {
            editRequest(requestId, { description: description.length > 0 ? description : null });
          }}
        />
        <EnumSetting
          label="Encoding"
          hint="The character set the envelope is encoded in on the wire."
          value={properties.encoding}
          // A value a hand-edited project file set that is not one of the known labels still
          // shows (rather than silently snapping to the first option); picking a different
          // entry replaces it.
          options={
            ENCODING_OPTIONS.some((option) => option.value === properties.encoding)
              ? ENCODING_OPTIONS
              : [...ENCODING_OPTIONS, { value: properties.encoding, label: properties.encoding }]
          }
          onChange={(encoding) => patch({ encoding })}
        />
        <NumberSetting
          label="Timeout (ms)"
          hint="How long to wait for an answer; empty uses the project default."
          value={properties.timeoutMs}
          min={0}
          placeholder="project default"
          testId="request-timeout"
          onCommit={(timeoutMs) => patch({ timeoutMs: timeoutMs ?? null })}
        />
        <TextSetting
          label="Bind address"
          hint="The local network address to send from; empty lets the system choose."
          value={properties.bindAddress ?? ''}
          placeholder="any interface"
          onCommit={(bindAddress) => patch({ bindAddress: bindAddress.length > 0 ? bindAddress : null })}
        />
        <BooleanSetting
          label="Follow redirects"
          hint="Follow a 3xx answer to where it points instead of showing it."
          value={properties.followRedirects}
          onChange={(followRedirects) => patch({ followRedirects })}
        />
        <BooleanSetting
          label="Skip SOAP action"
          hint="Leave the SOAPAction header (or action parameter) out of the request."
          value={properties.skipSoapAction}
          onChange={(skipSoapAction) => patch({ skipSoapAction })}
        />
        <NumberSetting
          label="Max size (bytes)"
          hint="Stop reading a response larger than this; empty reads it all."
          value={properties.maxSizeBytes}
          min={0}
          placeholder="unlimited"
          onCommit={(maxSizeBytes) => patch({ maxSizeBytes: maxSizeBytes ?? null })}
        />
        {/* A file on the machine that sends; a host without one has nowhere to write it. */}
        {hasCapability('files') && (
          <div className="flex items-end gap-2">
            <div className="min-w-0 flex-1">
              <TextSetting
                label="Dump file"
                hint="Write every response of this request to this file as well."
                value={properties.dumpFile ?? ''}
                monospace
                placeholder="no dump"
                onCommit={(dumpFile) => patch({ dumpFile: dumpFile.length > 0 ? dumpFile : null })}
              />
            </div>
            {hasCapability('dialogs') && (
              <button
                type="button"
                className="mb-0.5 h-row shrink-0 rounded-md border border-hairline-strong bg-surface-raised px-2 text-sm text-fg-default hover:bg-surface-hover"
                onClick={() => {
                  void pickDumpFile();
                }}
              >
                Browse…
              </button>
            )}
          </div>
        )}
        <BooleanSetting
          label="Pretty print"
          hint="Indent the envelope before sending it."
          value={properties.prettyPrint}
          onChange={(prettyPrint) => patch({ prettyPrint })}
        />
        <BooleanSetting
          label="Strip whitespaces"
          hint="Remove whitespace between elements before sending."
          value={properties.stripWhitespaces}
          onChange={(stripWhitespaces) => patch({ stripWhitespaces })}
        />
        <BooleanSetting
          label="Remove empty content"
          hint="Drop elements left empty, or holding only the ? template value, before sending."
          value={properties.removeEmptyContent}
          onChange={(removeEmptyContent) => patch({ removeEmptyContent })}
        />
        <BooleanSetting
          label="Entitize properties"
          hint="Escape XML characters in values that ${…} expansions put into the envelope."
          value={properties.entitizeProperties}
          onChange={(entitizeProperties) => patch({ entitizeProperties })}
        />
        <EnumSetting
          label="SSL Keystore"
          testId="request-ssl-keystore"
          value={properties.sslKeystoreRef ?? ''}
          hint={SSL_KEYSTORE_HINT}
          // A ref the project file still names after its keystore was removed elsewhere stays
          // selectable (and visible) rather than silently snapping to "none".
          options={[
            { value: '', label: '—' },
            ...keystores.map((keystore) => ({ value: keystore.id, label: keystore.name })),
            ...(properties.sslKeystoreRef !== undefined &&
            !keystores.some((keystore) => keystore.id === properties.sslKeystoreRef)
              ? [{ value: properties.sslKeystoreRef, label: `${properties.sslKeystoreRef} (missing)` }]
              : []),
          ]}
          onChange={(sslKeystoreRef) => patch({ sslKeystoreRef: sslKeystoreRef.length > 0 ? sslKeystoreRef : null })}
        />
      </SettingsGroup>
    </div>
  );
}
