/**
 * The composer under the timeline: one message, typed and sent on the open session.
 *
 * A plain textarea rather than Monaco, as the gRPC stream composer is — this is a line of a
 * conversation, not a document kept between sessions (the Messages tab keeps those). *Text* sends
 * what is typed, property-expanded unless *Expand properties* is off; *Binary* reads the text as
 * hex or base64 and refuses anything else before it reaches the wire, saying why. `Mod+Enter` in
 * the textarea sends and goes no further, so the editor's own `Mod+Enter` (send the selected saved
 * message) does not fire as well. A failed send keeps the text and says what went wrong under it.
 */
import { useState } from 'react';
import { Send } from 'lucide-react';
import { Button } from '../../components/button.js';
import { parseBinaryInput } from './ws-format.js';

export interface WsComposedMessage {
  readonly format: 'text' | 'binary';
  /** The text as typed, or base64 for binary. */
  readonly content: string;
  readonly expand: boolean;
}

export interface WsComposerProps {
  /** Whether the session is open; Send is disabled otherwise. */
  readonly open: boolean;
  /** Sends one message; answers the error message when it failed, `undefined` when it went. */
  readonly onSend: (message: WsComposedMessage) => Promise<string | undefined>;
  readonly sendShortcut?: string | undefined;
}

/** The composer. */
export function WsComposer({ open, onSend, sendShortcut }: WsComposerProps) {
  const [text, setText] = useState('');
  const [format, setFormat] = useState<'text' | 'binary'>('text');
  const [expand, setExpand] = useState(true);
  const [error, setError] = useState<string | undefined>(undefined);
  const [sending, setSending] = useState(false);

  const binary = format === 'binary' && text.trim() !== '' ? parseBinaryInput(text) : undefined;
  const problem = binary !== undefined && !binary.ok ? binary.reason : undefined;
  const canSend = open && !sending && text !== '' && problem === undefined;

  const send = async (): Promise<void> => {
    if (!canSend) return;
    const content = binary?.ok === true ? binary.base64 : text;
    setSending(true);
    const failure = await onSend({ format, content, expand: format === 'text' && expand });
    setSending(false);
    setError(failure);
    if (failure === undefined) {
      setText('');
    }
  };

  return (
    <div data-testid="ws-composer" className="shrink-0 border-t border-hairline p-2">
      <div className="mb-1 flex flex-wrap items-center gap-3 text-xs text-fg-muted">
        <fieldset className="flex items-center gap-2">
          <legend className="sr-only">Message format</legend>
          {(['text', 'binary'] as const).map((option) => (
            <label key={option} className="flex items-center gap-1">
              <input
                type="radio"
                name="ws-composer-format"
                checked={format === option}
                onChange={() => {
                  setFormat(option);
                }}
              />
              {option === 'text' ? 'Text' : 'Binary'}
            </label>
          ))}
        </fieldset>
        <label className="flex items-center gap-1">
          <input
            type="checkbox"
            checked={expand}
            disabled={format === 'binary'}
            onChange={(event) => {
              setExpand(event.target.checked);
            }}
          />
          Expand properties
        </label>
      </div>
      <div className="flex items-start gap-2">
        <textarea
          aria-label="Message to send"
          aria-describedby={problem !== undefined || error !== undefined ? 'ws-composer-problem' : undefined}
          data-testid="ws-composer-text"
          spellCheck={false}
          rows={3}
          value={text}
          placeholder={format === 'binary' ? 'Hex (0a ff 10) or base64' : 'A message'}
          onChange={(event) => {
            setText(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              event.stopPropagation();
              void send();
            }
          }}
          className="min-h-0 flex-1 rounded-md border border-hairline-strong bg-surface-raised p-2 font-mono text-xs text-fg-default focus:ring-1 focus:ring-accent focus:outline-none"
        />
        <Button
          variant="primary"
          data-testid="ws-composer-send"
          disabled={!canSend}
          onClick={() => {
            void send();
          }}
          title={open ? (sendShortcut !== undefined ? `Send (${sendShortcut})` : 'Send') : 'Connect to send'}
        >
          <Send size={12} aria-hidden="true" />
          Send
        </Button>
      </div>
      {(problem ?? error) !== undefined && (
        <p id="ws-composer-problem" role="alert" className="mt-1 text-xs text-status-danger">
          {problem ?? error}
        </p>
      )}
    </div>
  );
}
