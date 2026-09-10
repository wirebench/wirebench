import { Send, Square } from 'lucide-react';
import { Button } from '../../components/button.js';
import type { RequestDraft } from '../../state/project.js';
import type { InterfaceSummary } from '../../../shared/wire-types.js';
import { EndpointSelect } from './endpoint-select.js';

export interface RequestToolbarProps {
  readonly draft: RequestDraft;
  readonly summary: InterfaceSummary | undefined;
  /** The URL the request resolves to today (see `selectRequestEndpoint`), if any. */
  readonly endpoint: string | undefined;
  readonly sending: boolean;
  readonly onSend: () => void;
  readonly onCancel: () => void;
  readonly onEndpointChange: (endpoint: string) => void;
  /** The formatted `Mod+Enter` shortcut, shown on the Send button's title. */
  readonly sendShortcut?: string | undefined;
}

/** The request editor's top strip: send/cancel, endpoint, and the operation's identity. */
export function RequestToolbar({
  draft,
  summary,
  endpoint,
  sending,
  onSend,
  onCancel,
  onEndpointChange,
  sendShortcut,
}: RequestToolbarProps) {
  return (
    <div className="flex h-title-bar shrink-0 items-center gap-3 border-b border-hairline bg-surface-base px-3">
      {sending ? (
        <Button variant="secondary" onClick={onCancel} title="Cancel (Esc)">
          <Square size={12} aria-hidden="true" />
          Cancel
        </Button>
      ) : (
        <Button
          data-testid="request-send"
          variant="primary"
          onClick={onSend}
          disabled={endpoint === undefined || endpoint.length === 0}
          {...(sendShortcut !== undefined ? { title: `Send (${sendShortcut})` } : {})}
        >
          <Send size={12} aria-hidden="true" />
          Send
        </Button>
      )}

      <EndpointSelect summary={summary} bindingName={draft.bindingName} value={endpoint} onChange={onEndpointChange} />

      <div className="flex shrink-0 items-center gap-2 text-sm">
        <span className="font-mono text-fg-default">{draft.operationName}</span>
        <span className="rounded-sm border border-hairline px-1 text-xs text-fg-muted">SOAP {draft.soapVersion}</span>
      </div>

      <span className="max-w-[18rem] shrink-0 truncate font-mono text-xs text-fg-subtle" title={draft.soapAction ?? ''}>
        {draft.soapAction !== undefined && draft.soapAction.length > 0
          ? `SOAPAction: ${draft.soapAction}`
          : 'no SOAPAction'}
      </span>
    </div>
  );
}
