import { useMemo } from 'react';
import { KvTable } from '../../../components/kv-table.js';
import { useProblemsStore } from '../../../state/problems.js';
import { useProjectStore } from '../../../state/project.js';
import type { HeaderEntryWire, KeyValueWire, RequestWire } from '../../../../shared/wire-types.js';

export interface HeadersInspectorProps {
  readonly requestId: string;
}

/** Matches the message `exchanges.ts` builds for an unresolved reference found inside a header. */
function problemsForHeader(messages: readonly string[], name: string): string[] {
  const needle = `in header "${name}"`;
  return messages.filter((message) => message.includes(needle));
}

/**
 * The headers every send computes from the binding — the engine's `soapActionHeaders`, mirrored
 * here because the renderer may not import the engine. A typed row of the same name replaces the
 * computed one, so a computed row is only listed while nothing typed (and switched on) names it.
 */
export function computedSoapHeaders(request: RequestWire): KeyValueWire[] {
  const charset = request.properties.encoding.length > 0 ? request.properties.encoding : 'UTF-8';
  const skip = request.properties.skipSoapAction;
  const action = request.soapAction ?? '';
  const rows: KeyValueWire[] =
    request.soapVersion === '1.1'
      ? [
          {
            name: 'Content-Type',
            value: `text/xml;charset=${charset}`,
            enabled: true,
            description: 'from the binding',
          },
          ...(skip
            ? []
            : [{ name: 'SOAPAction', value: `"${action}"`, enabled: true, description: 'from the operation' }]),
        ]
      : [
          {
            name: 'Content-Type',
            value: `application/soap+xml;charset=${charset}${!skip && action.length > 0 ? `;action="${action}"` : ''}`,
            enabled: true,
            description: 'from the binding',
          },
        ];
  const typed = new Set(
    request.headers.filter((header) => header.enabled !== false).map((header) => header.name.toLowerCase()),
  );
  return rows.filter((row) => !typed.has(row.name.toLowerCase()));
}

function toRow(header: HeaderEntryWire): KeyValueWire {
  return {
    name: header.name,
    value: header.value,
    enabled: header.enabled !== false,
    ...(header.description !== undefined ? { description: header.description } : {}),
  };
}

/** Back to a saved header: `enabled` and `description` are only written when they say something. */
function toHeader(row: KeyValueWire): HeaderEntryWire {
  return {
    name: row.name,
    value: row.value,
    ...(row.enabled ? {} : { enabled: false }),
    ...(row.description !== undefined && row.description.length > 0 ? { description: row.description } : {}),
  };
}

/**
 * The request pane's Headers tab, in the same table the REST editor uses: the ordered,
 * duplicate-tolerating list of headers this request adds to (or overrides on) every send, with
 * the headers the binding computes greyed underneath. A row switched off stays in the request
 * but is not sent. Values may carry `${...}` property expansions; any that would not resolve are
 * reported under the table, from the same Problems entries the preflight writes.
 */
export function HeadersInspector({ requestId }: HeadersInspectorProps) {
  const request = useProjectStore((state) => state.requests[requestId]);
  const editRequest = useProjectStore((state) => state.editRequest);
  // Select the raw list and narrow it here: a selector that built a new array on every call
  // would give zustand a fresh snapshot each render and loop forever.
  const problemItems = useProblemsStore((state) => state.items);
  const expansionMessages = useMemo(
    () =>
      problemItems
        .filter((item) => item.source === 'expansion' && item.requestId === requestId)
        .map((item) => item.problem.message),
    [problemItems, requestId],
  );

  if (request === undefined) {
    return <p className="p-3 text-sm text-fg-subtle">This request no longer exists.</p>;
  }

  const problems = request.headers.flatMap((header) =>
    header.enabled === false ? [] : problemsForHeader(expansionMessages, header.name),
  );

  return (
    <div data-testid="soap-headers" className="flex flex-col gap-1 overflow-auto p-3">
      <KvTable
        label="Request headers"
        testidPrefix="soap-header"
        rows={request.headers.map(toRow)}
        columns={['enabled', 'name', 'value', 'description']}
        computed={computedSoapHeaders(request)}
        placeholders={{ name: 'header', value: 'value' }}
        emptyMessage="No headers of its own."
        onChange={(rows) => {
          editRequest(requestId, { headers: rows.map(toHeader) });
        }}
      />
      {problems.map((problem) => (
        <p key={problem} role="status" className="text-xs text-status-warning">
          {problem}
        </p>
      ))}
    </div>
  );
}
