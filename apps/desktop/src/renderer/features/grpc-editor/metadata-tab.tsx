/**
 * The metadata the call sends: the request's own entries, and — greyed under them — the ones the
 * API sets for every call and the ones the transport adds itself, so the tab shows everything that
 * goes on the wire and nothing that does not.
 */
import { KvTable } from '../../components/kv-table.js';
import type { GrpcRequestPatchWire, KeyValueWire } from '../../../shared/wire-types.js';

export interface MetadataTabProps {
  readonly metadata: readonly KeyValueWire[];
  /** The API's own metadata, sent before the request's. */
  readonly apiMetadata: readonly KeyValueWire[];
  readonly onChange: (patch: GrpcRequestPatchWire) => void;
}

/** The headers every gRPC call carries whether or not anything is typed. */
const TRANSPORT_ROWS: readonly KeyValueWire[] = [
  { name: 'content-type', value: 'application/grpc+proto', enabled: true, description: 'the protocol' },
  { name: 'te', value: 'trailers', enabled: true, description: 'the protocol' },
];

/** The Metadata tab. */
export function MetadataTab({ metadata, apiMetadata, onChange }: MetadataTabProps) {
  const typed = new Set(metadata.filter((row) => row.enabled).map((row) => row.name.toLowerCase()));
  const computed = [
    ...apiMetadata
      .filter((row) => row.enabled && !typed.has(row.name.toLowerCase()))
      .map((row) => ({ ...row, description: 'from the API' })),
    ...TRANSPORT_ROWS,
  ];

  return (
    <div data-testid="grpc-metadata" className="flex flex-col gap-1 overflow-auto p-3">
      <KvTable
        label="Request metadata"
        testidPrefix="grpc-metadata"
        rows={metadata}
        columns={['enabled', 'name', 'value', 'description']}
        computed={computed}
        placeholders={{ name: 'key', value: 'value' }}
        emptyMessage="No metadata of its own."
        onChange={(rows) => {
          onChange({ metadata: [...rows] });
        }}
      />
    </div>
  );
}
