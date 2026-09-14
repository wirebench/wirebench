/**
 * The headers the request sends: the ones typed here, and — greyed under them — the ones the
 * request computes for itself.
 *
 * The computed rows are shown because their absence is confusing: a user who has not set a content
 * type still sends one, and a user reading the tab should see everything that goes on the wire.
 * They are not editable, because editing them means editing the thing that produced them (the body's
 * kind, the API's credentials).
 */
import { KvTable } from '../../components/kv-table.js';
import type { KeyValueWire, RestBodyWire, RestRequestPatchWire } from '../../../shared/wire-types.js';

export interface HeadersTabProps {
  readonly headers: readonly KeyValueWire[];
  /** The body, which is what decides the computed content type. */
  readonly body: RestBodyWire;
  readonly onChange: (patch: RestRequestPatchWire) => void;
}

/** The content type a body implies, or `undefined` when the request sends none. */
export function computedContentType(body: RestBodyWire): string | undefined {
  switch (body.kind) {
    case 'none':
      return undefined;
    case 'raw':
      return body.contentType ?? RAW_CONTENT_TYPE[body.language];
    case 'form':
      return 'application/x-www-form-urlencoded';
    case 'multipart':
      return 'multipart/form-data; boundary=…';
    case 'binary':
      return body.contentType;
  }
}

/** The content type each raw language defaults to, matching the engine's own body encoder. */
const RAW_CONTENT_TYPE: Readonly<Record<string, string>> = {
  json: 'application/json',
  xml: 'application/xml',
  html: 'text/html',
  javascript: 'application/javascript',
  text: 'text/plain',
};

/** The Headers tab. */
export function HeadersTab({ headers, body, onChange }: HeadersTabProps) {
  const contentType = computedContentType(body);
  // Only when the user has not set one: a typed `Content-Type` wins, and showing both would
  // suggest two are sent.
  const typed = headers.some((header) => header.name.toLowerCase() === 'content-type' && header.enabled);
  const computed: KeyValueWire[] =
    contentType === undefined || typed
      ? []
      : [{ name: 'Content-Type', value: contentType, enabled: true, description: 'from the body' }];

  return (
    <div data-testid="rest-headers" className="flex flex-col gap-1 overflow-auto p-3">
      <KvTable
        label="Request headers"
        testidPrefix="rest-header"
        rows={headers}
        columns={['enabled', 'name', 'value', 'description']}
        computed={computed}
        placeholders={{ name: 'header', value: 'value' }}
        emptyMessage="No headers of its own."
        onChange={(rows) => {
          onChange({ headers: [...rows] });
        }}
      />
    </div>
  );
}
