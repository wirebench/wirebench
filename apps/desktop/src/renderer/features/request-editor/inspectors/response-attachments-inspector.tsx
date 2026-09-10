import { ExternalLink, Save } from 'lucide-react';
import { showToast } from '../../../components/toast.js';
import { formatBytes } from '../../../lib/format-size.js';
import { ipc } from '../../../state/ipc-client.js';
import type { ExchangeSummary } from '../../../../shared/wire-types.js';
import { InspectorIconButton } from './inspector-strip.js';

export interface ResponseAttachmentsInspectorProps {
  /** The exchange whose response parts to list; absent before the first send. */
  readonly exchange: ExchangeSummary | undefined;
}

/**
 * The response pane's Attachments inspector: the MIME/MTOM parts that came back beside the
 * envelope.
 *
 * The bytes are not here and never were — they stay in main's exchange cache, addressed by
 * `sendId` + `index`. Save as… and Open are therefore both round trips, and both can answer
 * `unknown-attachment` once the exchange has been evicted, which is what the toast reports.
 */
export function ResponseAttachmentsInspector({ exchange }: ResponseAttachmentsInspectorProps) {
  const attachments = exchange?.response?.attachments ?? [];
  const sendId = exchange?.sendId;

  if (sendId === undefined || attachments.length === 0) {
    return <p className="p-3 text-sm text-fg-subtle">No attachments in this response</p>;
  }

  const run = async (promise: Promise<{ ok: boolean; error?: { message: string } }>): Promise<void> => {
    const result = await promise;
    if (!result.ok && result.error !== undefined) {
      showToast(result.error.message);
    }
  };

  return (
    <div className="flex flex-col gap-1 p-2">
      <table
        data-testid="response-attachments-table"
        aria-label="Response attachments"
        className="w-full border-collapse text-sm"
      >
        <thead>
          <tr className="text-left text-xs tracking-wider text-fg-subtle uppercase">
            <th className="pb-1 font-medium">Content ID</th>
            <th className="pb-1 font-medium">Content type</th>
            <th className="pb-1 font-medium">Size</th>
            <th className="pb-1 font-medium">Name</th>
            <th className="w-16" />
          </tr>
        </thead>
        <tbody>
          {attachments.map((attachment) => (
            <tr key={attachment.index} data-testid="response-attachment-row" className="align-middle">
              <td className="py-0.5 pr-2 font-mono text-xs break-all text-fg-default">{attachment.contentId}</td>
              <td className="py-0.5 pr-2 font-mono text-xs text-fg-muted">{attachment.contentType}</td>
              <td
                className="py-0.5 pr-2 text-xs whitespace-nowrap text-fg-muted"
                title={`${String(attachment.size)} bytes`}
              >
                {formatBytes(attachment.size)}
              </td>
              <td className="py-0.5 pr-2 text-xs text-fg-muted">{attachment.name ?? '—'}</td>
              <td className="py-0.5 whitespace-nowrap">
                <InspectorIconButton
                  label="Save attachment as…"
                  onClick={() => {
                    void run(ipc().attachments.saveResponse({ sendId, index: attachment.index }));
                  }}
                >
                  <Save size={13} aria-hidden="true" />
                </InspectorIconButton>
                <InspectorIconButton
                  label="Open attachment"
                  onClick={() => {
                    void run(ipc().attachments.openResponse({ sendId, index: attachment.index }));
                  }}
                >
                  <ExternalLink size={13} aria-hidden="true" />
                </InspectorIconButton>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
