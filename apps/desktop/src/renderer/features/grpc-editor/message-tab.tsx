/**
 * The request message: JSON in the protobuf JSON mapping, edited in Monaco.
 *
 * A unary or server-streaming call sends one message, so the text is one JSON object. A call that
 * streams from the client sends several, and the text is either a JSON array of objects or one
 * object per line; the hint under the editor says which applies. *Reset to sample* asks main for a
 * skeleton of the method's request type — every field with a zero value — so a user starting from
 * nothing can see what the message wants.
 */
import { Button } from '../../components/button.js';
import { CodeEditor } from '../../editor/code-editor.js';
import { SAVE_KEYBINDING, SEND_KEYBINDING } from '../../editor/monaco.js';
import type { GrpcMethodKindWire } from '../../../shared/wire-types.js';

export interface MessageTabProps {
  readonly message: string;
  readonly methodKind: GrpcMethodKindWire;
  /** The request type the sample is made of; absent when the method is unset or undescribed. */
  readonly requestType?: string | undefined;
  readonly onChange: (message: string) => void;
  /** Replaces the text with the method's sample; absent when no definition can produce one. */
  readonly onResetToSample?: (() => void) | undefined;
  readonly onSend?: () => void;
  readonly onSave?: () => void;
}

/** Whether the method's request side streams, which decides how many messages the text holds. */
export function clientStreams(kind: GrpcMethodKindWire): boolean {
  return kind === 'client-streaming' || kind === 'bidi-streaming';
}

/** The Message tab. */
export function MessageTab({
  message,
  methodKind,
  requestType,
  onChange,
  onResetToSample,
  onSend,
  onSave,
}: MessageTabProps) {
  return (
    <div data-testid="grpc-message" className="flex h-full min-h-0 flex-col gap-2 p-3">
      <div className="flex shrink-0 items-center gap-2">
        <p className="min-w-0 flex-1 truncate text-xs text-fg-subtle" data-testid="grpc-message-hint">
          {requestType !== undefined && <span className="font-mono">{requestType}</span>}
          {requestType !== undefined && ' · '}
          {clientStreams(methodKind)
            ? 'Several messages: a JSON array, or one JSON object per line.'
            : 'One message, as JSON.'}
        </p>
        {onResetToSample !== undefined && (
          <Button variant="secondary" data-testid="grpc-message-sample" onClick={onResetToSample}>
            Reset to sample
          </Button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-hidden rounded border border-hairline-strong">
        <CodeEditor
          value={message}
          language="json"
          ariaLabel="Request message"
          onChange={onChange}
          onMount={(editor) => {
            editor.addCommand(SEND_KEYBINDING, () => {
              onSend?.();
            });
            editor.addCommand(SAVE_KEYBINDING, () => {
              onSave?.();
            });
          }}
        />
      </div>
    </div>
  );
}
