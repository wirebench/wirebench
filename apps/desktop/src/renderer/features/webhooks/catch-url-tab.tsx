/**
 * A catch URL's tab (webhook-capture spec §4.2): its URL and state on top, the capture list on the
 * left (newest first, streaming while live, older pages on demand), the selected capture on the
 * right. Nothing is cached: offline, the tab asks to connect (§4.2); lost access closes it (§6, R9).
 */
import { useEffect, useState } from 'react';
import { Copy } from 'lucide-react';
import { Button } from '../../components/button.js';
import { showToast } from '../../components/toast.js';
import { formatBytes } from '../../lib/format-size.js';
import { useCaptureFocusStore } from '../../state/capture-focus.js';
import { useEditorsStore } from '../../state/editors.js';
import { ipc } from '../../state/ipc-client.js';
import { originOf, useWebhooksStore } from '../../state/webhooks.js';
import { InspectorIconButton } from '../request-editor/inspectors/inspector-strip.js';
import { rememberCapture } from '../webhook-items/save-as-webhook.js';
import { useWebhookItemsDialogs } from '../webhook-items/webhook-items-state.js';
import { CaptureViewer } from './capture-viewer.js';
import { SignatureBadge } from './signature-badge.js';
import { useCaptureView, type Problem } from './use-capture-view.js';
import { catchUrlTabId } from './webhooks-actions.js';
import type { CaptureViewWire } from '../../../shared/wire-types.js';

/** Codes that mean "not reachable from here right now", not "something is wrong". */
const OFFLINE_CODES: ReadonlySet<string> = new Set([
  'server-unreachable',
  'account-signed-out',
  'identity-unauthenticated',
]);

const NOTICE_CLASS = 'flex flex-col items-start gap-2 p-4 text-sm text-fg-default';

type Detail =
  | { readonly kind: 'none' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly capture: CaptureViewWire }
  | { readonly kind: 'failed'; readonly error: Problem };

export function CatchUrlTab({ hookId }: { readonly hookId: string }) {
  const server = useWebhooksStore((state) => state.server);
  const hook = useWebhooksStore((state) => state.hooks.find((candidate) => candidate.id === hookId));
  const listKnown = useWebhooksStore((state) => state.loaded && state.error === undefined);
  const markSeen = useWebhooksStore((state) => state.markSeen);
  const { state, retry, older } = useCaptureView(server, hookId);
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const [detail, setDetail] = useState<Detail>({ kind: 'none' });

  // A run's "Show capture" link: select that capture, once, whether the tab was already open or not.
  const focused = useCaptureFocusStore((focus) => (focus.focus?.hookId === hookId ? focus.focus.captureId : undefined));
  useEffect(() => {
    if (focused === undefined) return;
    setSelectedId(useCaptureFocusStore.getState().take(hookId));
  }, [focused, hookId]);

  const viewId = state.phase === 'open' ? state.viewId : undefined;
  const newest = state.phase === 'open' ? (state.captures[0]?.id ?? null) : undefined;
  const failedCode = state.phase === 'failed' ? state.error.code : undefined;

  // On screen is seen (§4.2): the badge counts only what arrived after this.
  useEffect(() => {
    if (newest !== undefined) markSeen(hookId, newest);
  }, [newest, hookId, markSeen]);

  // Lost access closes the tab, as the workspace's other tabs go when it does (§6, R9).
  useEffect(() => {
    if (failedCode === 'teams-workspace-not-found') useEditorsStore.getState().close(catchUrlTabId(hookId));
  }, [failedCode, hookId]);

  // The newest capture is selected until the user picks one.
  const shown = selectedId ?? newest ?? undefined;
  useEffect(() => {
    if (viewId === undefined || shown === undefined) {
      setDetail({ kind: 'none' });
      return;
    }
    let current = true;
    setDetail({ kind: 'loading' });
    void ipc()
      .hooks.capture({ viewId, captureId: shown })
      .then((result) => {
        if (!current) return;
        if (result.ok) {
          // Save-as-webhook (Task 15) reads this back by id: refetching it would need this view's
          // `viewId`, which only this tab still has once the dialog opens.
          rememberCapture(result.value.capture);
        }
        setDetail(
          result.ok ? { kind: 'ready', capture: result.value.capture } : { kind: 'failed', error: result.error },
        );
      });
    return () => {
      current = false;
    };
  }, [viewId, shown]);

  const origin = originOf(server?.url ?? hook?.url ?? '');
  if (server === undefined || (failedCode !== undefined && OFFLINE_CODES.has(failedCode))) {
    return (
      <div data-testid="catch-url-offline" className={NOTICE_CLASS}>
        <p>{`Connect to ${origin} to see captures.`}</p>
        <Button onClick={retry}>Retry</Button>
      </div>
    );
  }
  if (failedCode === 'hooks-not-found' || (listKnown && hook === undefined)) {
    return (
      <div className={NOTICE_CLASS}>
        <p data-testid="catch-url-deleted">This catch URL was deleted.</p>
      </div>
    );
  }
  if (state.phase === 'failed') {
    return (
      <div data-testid="catch-url-error" className={NOTICE_CLASS}>
        <p>{`Could not load captures: ${state.error.message}`}</p>
        <Button onClick={retry}>Retry</Button>
      </div>
    );
  }

  return (
    <div data-testid="catch-url-tab" className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 items-center gap-2 border-b border-hairline px-3 py-2">
        <span className="shrink-0 text-sm font-medium text-fg-default">{hook?.name}</span>
        <code data-testid="catch-url-address" className="min-w-0 truncate font-mono text-xs text-fg-muted">
          {hook?.url}
        </code>
        <InspectorIconButton
          label="Copy URL"
          onClick={() => {
            if (hook === undefined) return;
            void navigator.clipboard?.writeText(hook.url).then(() => showToast('Catch URL copied'));
          }}
        >
          <Copy size={13} aria-hidden="true" />
        </InspectorIconButton>
        <span
          data-testid="catch-url-state"
          className="ml-auto shrink-0 rounded-full bg-surface-base px-1.5 text-xs text-fg-subtle"
        >
          {hook?.enabled === false ? 'Disabled' : 'Enabled'}
        </span>
      </header>
      {state.phase === 'open' && state.error !== undefined && (
        <div
          role="status"
          data-testid="catch-url-error"
          className="flex shrink-0 items-center gap-3 border-b border-hairline bg-surface-sunken px-3 py-1.5 text-sm"
        >
          <span>{`Could not refresh captures: ${state.error.message}`}</span>
          <Button onClick={retry}>Retry</Button>
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        <ol
          aria-label="Captures"
          className="w-72 shrink-0 overflow-auto border-r border-hairline"
          onScroll={(event) => {
            const list = event.currentTarget;
            if (list.scrollTop + list.clientHeight >= list.scrollHeight - 40) older();
          }}
        >
          {state.phase === 'opening' && <li className="p-3 text-sm text-fg-subtle">Loading captures…</li>}
          {state.phase === 'open' && state.captures.length === 0 && (
            <li data-testid="capture-empty" className="p-3 text-sm text-fg-subtle">
              No captures yet. Send a request to the URL above.
            </li>
          )}
          {state.phase === 'open' &&
            state.captures.map((capture) => (
              <li key={capture.id}>
                <button
                  type="button"
                  data-testid="capture-row"
                  aria-current={capture.id === shown}
                  onClick={() => setSelectedId(capture.id)}
                  className={`flex w-full items-center gap-2 px-3 py-1 text-left text-xs ${
                    capture.id === shown ? 'bg-accent-muted' : 'hover:bg-surface-raised'
                  }`}
                >
                  <span className="w-12 shrink-0 font-mono font-medium">{capture.method}</span>
                  <span className="min-w-0 flex-1 truncate font-mono">
                    {capture.subpath === '' ? '/' : capture.subpath}
                  </span>
                  <SignatureBadge signature={capture.signature} rejected={capture.rejected} />
                  <span className="shrink-0 text-fg-subtle">{new Date(capture.receivedAt).toLocaleTimeString()}</span>
                  <span className="shrink-0 text-fg-subtle">{formatBytes(capture.bodySize)}</span>
                </button>
              </li>
            ))}
          {state.phase === 'open' && state.more && (
            <li className="p-2">
              <Button data-testid="capture-load-older" disabled={state.loadingOlder} onClick={older}>
                {state.loadingOlder ? 'Loading…' : 'Load older'}
              </Button>
            </li>
          )}
        </ol>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {detail.kind === 'ready' ? (
            <CaptureViewer
              key={detail.capture.id}
              capture={detail.capture}
              {...(hook?.signature?.scheme !== undefined ? { signatureScheme: hook.signature.scheme } : {})}
              onSaveAsWebhook={() => useWebhookItemsDialogs.getState().openSaveAs(detail.capture.id)}
            />
          ) : detail.kind === 'failed' ? (
            <p className="p-4 text-sm text-fg-default">{`Could not open the capture: ${detail.error.message}`}</p>
          ) : detail.kind === 'loading' ? (
            <p className="p-4 text-sm text-fg-subtle">Loading…</p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
