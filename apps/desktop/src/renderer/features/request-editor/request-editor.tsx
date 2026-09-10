import { useCallback, useMemo } from 'react';
import { Group, Panel, Separator } from 'react-resizable-panels';
import { shortcutFor } from '../../lib/keybindings.js';
import { detectPlatform } from '../../lib/platform.js';
import { useExchangesStore } from '../../state/exchanges.js';
import { useProjectStore } from '../../state/project.js';
import { RequestPane } from './request-pane.js';
import { ResponsePane } from './response-pane.js';
import { RequestToolbar } from './toolbar.js';

export interface RequestEditorProps {
  readonly requestId: string;
  /** `horizontal` puts the panes side by side. Task 29 adds the toggle that flips this. */
  readonly layout?: 'horizontal' | 'vertical';
}

/** Mirrors `keybindings.ts`'s notion of "a keystroke the focused field should keep". */
function isTextInput(target: EventTarget): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  return target.tagName === 'TEXTAREA' || target.tagName === 'INPUT' || target.isContentEditable;
}

const SEPARATOR = 'bg-hairline transition-colors hover:bg-accent-muted focus-visible:bg-accent';

/**
 * One request tab: toolbar on top, request and response panes below. Everything it needs is
 * read from the stores by id, so a tab is fully described by its `requestId`.
 */
export function RequestEditor({ requestId, layout = 'horizontal' }: RequestEditorProps) {
  const draft = useProjectStore((state) => state.requests[requestId]);
  const summary = useProjectStore((state) => (draft === undefined ? undefined : state.interfaces[draft.interfaceId]));
  const updateRequest = useProjectStore((state) => state.updateRequest);
  const setEndpoint = useProjectStore((state) => state.setEndpoint);
  const exchange = useExchangesStore((state) => state.byRequest[requestId]);
  const send = useExchangesStore((state) => state.send);
  const cancel = useExchangesStore((state) => state.cancel);

  const sending = exchange?.status === 'sending';
  const platform = useMemo(() => detectPlatform(), []);

  const onSend = useCallback(() => {
    void send(requestId);
  }, [send, requestId]);
  const onCancel = useCallback(() => {
    void cancel(requestId);
  }, [cancel, requestId]);
  const onEnvelopeChange = useCallback(
    (envelopeXml: string) => {
      updateRequest(requestId, { envelopeXml });
    },
    [updateRequest, requestId],
  );
  const onEndpointChange = useCallback(
    (endpoint: string) => {
      setEndpoint(requestId, endpoint);
    },
    [setEndpoint, requestId],
  );

  if (draft === undefined) {
    return <p className="p-4 text-sm text-fg-subtle">This request no longer exists.</p>;
  }

  return (
    <section
      aria-label={`Request ${draft.name}`}
      data-testid="request-editor"
      className="flex h-full min-h-0 flex-col"
      onKeyDown={(event) => {
        // `request.cancel`'s Escape binding is declined inside text fields (see
        // `shouldIgnoreEvent`), and Monaco's input surface is one — so this handler covers
        // exactly that gap: a send in flight, with focus inside the editor. Anywhere else the
        // window-level binding still owns Escape, so neither can fire twice.
        if (event.key !== 'Escape' || !sending || !isTextInput(event.target)) {
          return;
        }
        event.preventDefault();
        onCancel();
      }}
    >
      <RequestToolbar
        draft={draft}
        summary={summary}
        sending={sending}
        onSend={onSend}
        onCancel={onCancel}
        onEndpointChange={onEndpointChange}
        sendShortcut={shortcutFor('request.send', platform)}
      />

      <Group orientation={layout} className={`flex min-h-0 flex-1 ${layout === 'horizontal' ? '' : 'flex-col'}`}>
        <Panel id="request-pane" defaultSize="50%" minSize="20%">
          <RequestPane envelopeXml={draft.envelopeXml} onEnvelopeChange={onEnvelopeChange} onSend={onSend} />
        </Panel>
        <Separator aria-label="Resize" className={`${SEPARATOR} ${layout === 'horizontal' ? 'w-px' : 'h-px'}`} />
        <Panel id="response-pane" minSize="20%">
          <ResponsePane state={exchange} />
        </Panel>
      </Group>
    </section>
  );
}
