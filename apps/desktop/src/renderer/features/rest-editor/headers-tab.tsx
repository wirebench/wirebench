/**
 * The headers the request sends: the ones typed here, and under them the ones the send adds on the
 * request's behalf.
 *
 * The generated rows are shown because their absence is confusing: a user who has not set a content
 * type still sends one, and a user reading the tab should see everything that goes on the wire. For a
 * REST request main lists them (`GeneratedHeaders`), each of which can be switched off or overridden;
 * the WebSocket editor, which has no such list, shows the body's content type greyed in the table.
 */
import { KvTable } from '../../components/kv-table.js';
import { GeneratedHeaders } from './generated-headers.js';
import type { RestBodyWire, RestRequestPatchWire, RestRequestWire } from '@shared/kinds/rest/wire.js';
import type { KeyValueWire } from '@shared/wire-base.js';

export interface HeadersTabProps {
  readonly headers: readonly KeyValueWire[];
  /** The body, which is what decides the computed content type. */
  readonly body: RestBodyWire;
  readonly onChange: (patch: RestRequestPatchWire) => void;
  /** A REST request, whose generated headers main lists under the table. */
  readonly request?: RestRequestWire;
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
    case 'graphql':
      return 'application/json';
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
export function HeadersTab({ headers, body, onChange, request }: HeadersTabProps) {
  // With main's list below, the table shows only what was typed: the list already has the content type.
  const contentType = request === undefined ? computedContentType(body) : undefined;
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
      {request !== undefined && <GeneratedHeaders request={request} onChange={onChange} />}
    </div>
  );
}
