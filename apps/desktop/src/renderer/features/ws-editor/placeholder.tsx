/**
 * Stand-in body for a WebSocket request's tab until the WebSocket editor itself exists.
 *
 * `editor-area.tsx` needs *something* to render for a `ws-request` tab today — otherwise opening
 * one shows a blank panel with no explanation. This component is the whole of that something, and
 * it is named so the task that builds the real editor (message compose, connect/disconnect, the
 * live exchange) knows to replace its body rather than add beside it.
 */
import { useProjectStore } from '../../state/project.js';

export interface WsEditorPlaceholderProps {
  readonly requestId: string;
}

/** What a WebSocket request's tab shows before the WebSocket editor is built. */
export function WsEditorPlaceholder({ requestId }: WsEditorPlaceholderProps) {
  const request = useProjectStore((state) => state.wsRequests[requestId]);

  return (
    <section
      aria-label={request !== undefined ? `WebSocket request ${request.name}` : 'WebSocket request'}
      data-testid="ws-editor-placeholder"
      className="flex h-full flex-col items-center justify-center gap-1 p-6 text-center"
    >
      <h2 className="text-sm font-medium text-fg-default">
        {request?.name ?? 'This request is no longer in the project.'}
      </h2>
      {request !== undefined && <p className="text-sm text-fg-subtle">The WebSocket editor is not here yet.</p>}
    </section>
  );
}
