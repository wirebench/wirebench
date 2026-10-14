/**
 * What a response pane shows when a send produced no response: what happened in plain words, the
 * whole message, the one hint that points at the fix, and Retry. The code is kept, small, for
 * searching and for bug reports, but it is no longer the headline.
 *
 * Protocol-neutral: the hint's links are callbacks, so each request kind wires them to its own
 * editor (a REST request's Settings tab, the field a `${name}` sits in).
 */
import { Button } from './button.js';
import {
  describeSendError,
  formatLimit,
  type SendErrorHint,
  type SendErrorLike,
} from '../features/request-editor/send-error.js';

export interface SendErrorPanelProps {
  readonly error: SendErrorLike;
  /** Absent hides Retry (nothing to send it again with). */
  readonly onRetry?: (() => void) | undefined;
  /** Why Retry cannot run now, shown as its tooltip; the button is disabled while set. */
  readonly retryDisabledReason?: string | undefined;
  /** Opens where the request's timeout is set. Absent leaves the limit as plain text. */
  readonly onOpenTimeoutSetting?: (() => void) | undefined;
  /** Shows the field an unresolved `${name}` was written in. Absent leaves each name as plain text. */
  readonly onRevealReference?: ((ref: string) => void) | undefined;
}

const LINK = 'text-accent hover:underline';

/** The panel that stands in for the response tabs after a failed send. */
export function SendErrorPanel({
  error,
  onRetry,
  retryDisabledReason,
  onOpenTimeoutSetting,
  onRevealReference,
}: SendErrorPanelProps) {
  const view = describeSendError(error);
  return (
    <div data-testid="send-error-panel" className="flex flex-col gap-2 overflow-auto p-3">
      <h3
        data-testid="send-error-title"
        className={`text-md font-medium ${view.tone === 'danger' ? 'text-status-danger' : 'text-fg-default'}`}
      >
        {view.title}
      </h3>
      <p data-testid="send-error-message" className="text-sm break-words whitespace-pre-wrap text-fg-default">
        {error.message}
      </p>
      {view.hint !== undefined && (
        <div data-testid="send-error-hint" className="text-sm text-fg-muted">
          <Hint hint={view.hint} onOpenTimeoutSetting={onOpenTimeoutSetting} onRevealReference={onRevealReference} />
        </div>
      )}
      <div className="mt-1 flex items-center gap-3">
        {onRetry !== undefined && (
          <Button
            variant={view.tone === 'danger' ? 'primary' : 'secondary'}
            data-testid="send-error-retry"
            disabled={retryDisabledReason !== undefined}
            title={retryDisabledReason}
            onClick={onRetry}
          >
            Retry
          </Button>
        )}
        <span data-testid="send-error-code" className="font-mono text-2xs text-fg-subtle">
          {error.code}
        </span>
      </div>
    </div>
  );
}

function Hint({
  hint,
  onOpenTimeoutSetting,
  onRevealReference,
}: {
  readonly hint: SendErrorHint;
  readonly onOpenTimeoutSetting: (() => void) | undefined;
  readonly onRevealReference: ((ref: string) => void) | undefined;
}) {
  if (hint.kind === 'text') {
    return <p>{hint.text}</p>;
  }
  if (hint.kind === 'timeout') {
    const limit = hint.timeoutMs !== undefined ? `the ${formatLimit(hint.timeoutMs)} limit` : 'its time limit';
    return (
      <p>
        No response arrived within {limit}.{' '}
        {onOpenTimeoutSetting !== undefined ? (
          <button
            type="button"
            data-testid="send-error-timeout-setting"
            className={LINK}
            onClick={onOpenTimeoutSetting}
          >
            Change the timeout
          </button>
        ) : (
          'Raise the timeout in the request settings'
        )}{' '}
        if the server is slow, or check that it answers at all.
      </p>
    );
  }
  if (hint.refs.length === 0) {
    return <p>A variable in this request has no value in the active environment.</p>;
  }
  return (
    <div>
      <p>Nothing gives these a value in the active environment:</p>
      <ul className="mt-1 flex flex-wrap gap-2">
        {hint.refs.map((ref) => (
          <li key={ref}>
            {onRevealReference !== undefined ? (
              <button
                type="button"
                data-testid="send-error-reference"
                className={`font-mono ${LINK}`}
                onClick={() => {
                  onRevealReference(ref);
                }}
              >
                {ref}
              </button>
            ) : (
              <code className="font-mono text-fg-default">{ref}</code>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
