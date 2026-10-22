/**
 * What a response pane shows when a send produced no response: what happened in plain words (naming
 * the host and port to check when the error says), the message when it adds to that, the one hint
 * that points at the fix, and Retry when sending again could end differently. The code and the
 * engine's own message are kept for bug reports, behind a Details disclosure (#747), so they never
 * read as part of the explanation.
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
  /** Names the field a reference was written in ("Header X-List"); absent or undefined says "This request". */
  readonly describeReferenceField?: ((ref: string) => string | undefined) | undefined;
}

const LINK = 'text-accent hover:underline';

/** The panel that stands in for the response tabs after a failed send. */
export function SendErrorPanel({
  error,
  onRetry,
  retryDisabledReason,
  onOpenTimeoutSetting,
  onRevealReference,
  describeReferenceField,
}: SendErrorPanelProps) {
  const view = describeSendError(error);
  return (
    <div data-testid="send-error-panel" className="flex flex-col gap-2 overflow-auto p-3">
      <h3
        data-testid="send-error-title"
        className={`text-md font-medium ${view.tone === 'danger' ? 'text-status-danger' : 'text-fg-default'}`}
      >
        {view.headline}
      </h3>
      {view.detail !== undefined && (
        <p data-testid="send-error-message" className="text-sm break-words whitespace-pre-wrap text-fg-default">
          {view.detail}
        </p>
      )}
      {view.hint !== undefined && (
        <div data-testid="send-error-hint" className="text-sm text-fg-muted">
          <Hint
            hint={view.hint}
            onOpenTimeoutSetting={onOpenTimeoutSetting}
            onRevealReference={onRevealReference}
            describeReferenceField={describeReferenceField}
          />
        </div>
      )}
      {onRetry !== undefined && view.retryable && (
        <div className="mt-1 flex items-center gap-3">
          <Button
            variant={view.tone === 'danger' ? 'primary' : 'secondary'}
            data-testid="send-error-retry"
            disabled={retryDisabledReason !== undefined}
            title={retryDisabledReason}
            onClick={onRetry}
          >
            Retry
          </Button>
        </div>
      )}
      <details data-testid="send-error-details" className="mt-1 text-2xs text-fg-subtle">
        <summary className="cursor-pointer select-none">Details</summary>
        <div className="mt-1 flex flex-col gap-0.5">
          <code data-testid="send-error-code" className="font-mono">
            {error.code}
          </code>
          {view.detail === undefined && error.message.trim() !== '' && (
            <span data-testid="send-error-raw" className="font-mono break-words whitespace-pre-wrap">
              {error.message}
            </span>
          )}
        </div>
      </details>
    </div>
  );
}

function Hint({
  hint,
  onOpenTimeoutSetting,
  onRevealReference,
  describeReferenceField,
}: {
  readonly hint: SendErrorHint;
  readonly onOpenTimeoutSetting: (() => void) | undefined;
  readonly onRevealReference: ((ref: string) => void) | undefined;
  readonly describeReferenceField: ((ref: string) => string | undefined) | undefined;
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
  if (hint.kind === 'unclosed') {
    return (
      <ul className="flex flex-col gap-1">
        {hint.fragments.map((fragment) => (
          <li key={fragment} data-testid="send-error-unclosed">
            {describeReferenceField?.(fragment) ?? 'This request'} has a <code className="font-mono">{'${'}</code> that
            is never closed: <ReferenceLink reference={fragment} onRevealReference={onRevealReference} />. Close it with{' '}
            <code className="font-mono">{'}'}</code>, or write <code className="font-mono">{'$${'}</code> for a literal{' '}
            <code className="font-mono">{'${'}</code>.
          </li>
        ))}
      </ul>
    );
  }
  if (hint.refs.length === 0) {
    return <p>A variable in this request has no value in the active environment.</p>;
  }
  // One plain sentence naming the variables (#747), each a link to the field it sits in: "${host}
  // has no value…", "${host} and ${port} have no value…", "${a}, ${b} and ${c} have no value…".
  const links = hint.refs.map((ref) => (
    <ReferenceLink key={ref} reference={ref} onRevealReference={onRevealReference} />
  ));
  const named =
    links.length === 1
      ? links
      : links.flatMap((link, index) =>
          index === 0 ? [link] : index === links.length - 1 ? [' and ', link] : [', ', link],
        );
  return (
    <p data-testid="send-error-unresolved">
      {named} {links.length === 1 ? 'has' : 'have'} no value in the active environment. Define{' '}
      {links.length === 1 ? 'it' : 'them'} there, or pick an environment that does.
    </p>
  );
}

/** A reference as a link to the field it sits in, or as plain code when there is nowhere to go. */
function ReferenceLink({
  reference,
  onRevealReference,
}: {
  readonly reference: string;
  readonly onRevealReference: ((ref: string) => void) | undefined;
}) {
  if (onRevealReference === undefined) {
    return <code className="font-mono text-fg-default">{reference}</code>;
  }
  return (
    <button
      type="button"
      data-testid="send-error-reference"
      className={`font-mono ${LINK}`}
      onClick={() => {
        onRevealReference(reference);
      }}
    >
      {reference}
    </button>
  );
}
