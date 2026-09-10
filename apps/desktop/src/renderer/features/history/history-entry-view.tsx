import { Group, Panel, Separator } from 'react-resizable-panels';
import { XmlEditor } from '../../editor/xml-editor.js';
import { prettyPrintXml } from '../../editor/xml-language.js';
import { formatBytes } from '../../lib/format-size.js';
import { Button } from '../../components/button.js';
import { showToast } from '../../components/toast.js';
import { useEditorsStore } from '../../state/editors.js';
import { useHistoryStore } from '../../state/history.js';
import { useProjectStore } from '../../state/project.js';
import { ipc } from '../../state/ipc-client.js';

export interface HistoryEntryViewProps {
  readonly historyId: string;
}

const SEPARATOR = 'bg-hairline transition-colors hover:bg-accent-muted focus-visible:bg-accent';

/**
 * A read-only "history" editor tab: one recorded send's request envelope and response, plus
 * Re-send and (when the original request still exists) a "Go to request" link.
 */
export function HistoryEntryView({ historyId }: HistoryEntryViewProps) {
  const entry = useHistoryStore((state) => state.entries.find((e) => e.id === historyId));
  const openTab = useEditorsStore((state) => state.open);
  const draftExists = useProjectStore((state) =>
    entry?.requestId !== undefined ? state.requests[entry.requestId] !== undefined : false,
  );

  if (entry === undefined) {
    return <p className="p-4 text-sm text-fg-subtle">This entry is no longer available.</p>;
  }

  const onResend = () => {
    void ipc()
      .history.resend({ id: entry.id })
      .then((result) => {
        if (!result.ok) {
          showToast(result.error.code);
        }
      });
  };

  const onGoToRequest = () => {
    if (entry.requestId === undefined) {
      return;
    }
    openTab({
      id: `request:${entry.requestId}`,
      kind: 'request',
      title: entry.requestName,
      requestId: entry.requestId,
    });
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-hairline px-3 py-2 text-sm">
        <div className="min-w-0">
          <p className="truncate font-medium text-fg-default">
            {entry.requestName}
            {entry.operationName.length > 0 ? ` · ${entry.operationName}` : ''}
          </p>
          <p className="truncate text-xs text-fg-subtle" title={entry.endpoint}>
            {new Date(entry.at).toLocaleString()} · {entry.endpoint} · {entry.durationMs} ms ·{' '}
            {formatBytes(entry.sizeBytes)}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {draftExists && (
            <Button variant="ghost" onClick={onGoToRequest}>
              Go to request
            </Button>
          )}
          <Button variant="secondary" onClick={onResend}>
            Re-send
          </Button>
        </div>
      </div>
      <div className="min-h-0 flex-1">
        <Group orientation="horizontal" className="flex h-full">
          <Panel defaultSize={50} minSize={20}>
            <XmlEditor
              ariaLabel="History request envelope"
              value={prettyPrintXml(entry.request.envelopeXml)}
              readOnly
            />
          </Panel>
          <Separator className={SEPARATOR} />
          <Panel defaultSize={50} minSize={20}>
            <XmlEditor
              ariaLabel="History response envelope"
              value={
                entry.response?.envelopeXml !== undefined
                  ? prettyPrintXml(entry.response.envelopeXml)
                  : (entry.error?.message ?? '')
              }
              readOnly
            />
          </Panel>
        </Group>
      </div>
    </div>
  );
}
