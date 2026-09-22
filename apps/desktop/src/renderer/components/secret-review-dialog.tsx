import * as AlertDialog from '@radix-ui/react-alert-dialog';
import type { SecretFindingWire } from '../../shared/wire-types.js';
import { useProjectStore } from '../state/project.js';
import { needsReplace, secretNameError, useSecretReviewStore } from '../state/secret-review.js';
import type { SecretReview, SecretReviewRow } from '../state/secret-review.js';
import { Button } from './button.js';

/** Each rule as a person would name what was found. */
const RULE_LABELS: Readonly<Record<SecretFindingWire['rule'], string>> = {
  'sensitive-name': 'Sensitive name',
  jwt: 'JSON web token',
  bearer: 'Bearer token',
  basic: 'Basic credentials',
  'aws-key': 'AWS access key',
  'private-key': 'Private key',
  'vendor-token': 'Access token',
  'high-entropy': 'Random-looking value',
};

function Row({ review, row, showProject }: { review: SecretReview; row: SecretReviewRow; showProject: boolean }) {
  const projectName = useProjectStore((state) => state.projects[row.projectId]?.name);
  const setName = useSecretReviewStore((state) => state.setName);
  const setReplace = useSecretReviewStore((state) => state.setReplace);
  const move = useSecretReviewStore((state) => state.move);
  const keep = useSecretReviewStore((state) => state.keep);
  const nameError = secretNameError(row.name);
  const replaceShown = needsReplace(review, row);
  // One id per row for the field's label and its messages; the key has a NUL in it, the id cannot.
  const id = `secret-review-${encodeURIComponent(row.key)}`;
  const messageId = `${id}-message`;
  const message =
    nameError ??
    (row.stale
      ? 'This value changed since it was found. Check it and try again.'
      : row.nameTaken && !row.replace
        ? 'This name already has a stored value. Pick another name, or replace it.'
        : undefined);

  return (
    <li data-testid="secret-review-row" className="border-b border-hairline py-2 last:border-b-0">
      <div className="flex items-baseline justify-between gap-2">
        <span className="min-w-0 truncate text-sm text-fg-default" title={row.finding.label}>
          {row.finding.label}
        </span>
        <span className="shrink-0 text-xs text-fg-subtle">{RULE_LABELS[row.finding.rule]}</span>
      </div>
      <div className="mt-0.5 flex items-baseline gap-2 text-xs text-fg-subtle">
        {showProject && projectName !== undefined && <span>{projectName}</span>}
        <span className="font-mono">{row.finding.preview}</span>
      </div>
      <div className="mt-1.5 flex items-center gap-2">
        <label htmlFor={id} className="sr-only">
          {`Secret name for ${row.finding.label}`}
        </label>
        <input
          id={id}
          value={row.name}
          spellCheck={false}
          aria-invalid={nameError !== undefined}
          {...(message === undefined ? {} : { 'aria-describedby': messageId })}
          onChange={(event) => {
            setName(row.key, event.target.value);
          }}
          className="min-w-0 flex-1 rounded border border-hairline-strong bg-surface-base px-2 py-1 font-mono text-sm text-fg-default outline-none focus:ring-1 focus:ring-accent aria-[invalid=true]:border-status-danger"
        />
        <Button
          disabled={review.busy || nameError !== undefined}
          onClick={() => {
            void move([row.key]);
          }}
        >
          Move to secret
        </Button>
        <Button
          variant="ghost"
          disabled={review.busy}
          onClick={() => {
            void keep([row.key]);
          }}
        >
          Keep
        </Button>
      </div>
      {message !== undefined && (
        <p id={messageId} className="mt-1 text-xs text-status-danger">
          {message}
        </p>
      )}
      {replaceShown && (
        <label className="mt-1 flex items-center gap-1.5 text-xs text-fg-default">
          <input
            type="checkbox"
            checked={row.replace}
            onChange={(event) => {
              setReplace(row.key, event.target.checked);
            }}
          />
          Replace the stored value
        </label>
      )}
    </li>
  );
}

/**
 * The secret review a manual save (or commit) waits on: one row per possible secret, each moved
 * into the secret store under a `${secret:name}` token or kept for the session, then the save goes
 * ahead. Mounted once in the shell and driven by `reviewSecrets`; the `ConfirmDialog` pattern —
 * Radix's `AlertDialog` gives it the role, the focus trap and Escape, which cancels.
 *
 * Only a preview of each value is ever shown: the values stay in main.
 */
export function SecretReviewDialog() {
  const review = useSecretReviewStore((state) => state.review);
  const moveAll = useSecretReviewStore((state) => state.moveAll);
  const proceed = useSecretReviewStore((state) => state.proceed);
  const cancel = useSecretReviewStore((state) => state.cancel);

  const count = review?.rows.length ?? 0;
  const showProject = new Set(review?.rows.map((row) => row.projectId)).size > 1;
  const anyInvalid = review?.rows.some((row) => secretNameError(row.name) !== undefined) ?? false;

  return (
    <AlertDialog.Root
      open={review !== null}
      onOpenChange={(open) => {
        if (!open) {
          cancel();
        }
      }}
    >
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="fixed inset-0 bg-black/40" />
        <AlertDialog.Content
          data-testid="secret-review-dialog"
          className="fixed top-1/2 left-1/2 flex max-h-[80vh] w-[40rem] max-w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-md bg-surface-raised p-4 shadow-lg"
        >
          <AlertDialog.Title className="text-md font-medium text-fg-default">
            {count === 1 ? 'Possible secret found' : `${count} possible secrets found`}
          </AlertDialog.Title>
          <AlertDialog.Description asChild>
            <div className="mt-1 text-sm text-fg-subtle">
              {review?.mode === 'commit' ? 'Before committing, move' : 'Before saving, move'} each value into the secret
              store — the file keeps a <code className="font-mono">{'${secret:name}'}</code> token instead — or keep it
              as it is until the project closes.
            </div>
          </AlertDialog.Description>
          {review !== null && (
            <ul className="mt-3 min-h-0 flex-1 overflow-y-auto">
              {review.rows.map((row) => (
                <Row key={row.key} review={review} row={row} showProject={showProject} />
              ))}
            </ul>
          )}
          {review?.notice !== undefined && <p className="mt-2 text-xs text-fg-subtle">{review.notice}</p>}
          {review?.error !== undefined && (
            <p role="alert" className="mt-2 text-sm text-status-danger">
              {review.error}
            </p>
          )}
          <div className="mt-4 flex items-center gap-2">
            <Button
              disabled={review === null || review.busy || anyInvalid}
              onClick={() => {
                void moveAll();
              }}
            >
              Move all
            </Button>
            <span className="flex-1" />
            <AlertDialog.Cancel asChild>
              <Button>Cancel</Button>
            </AlertDialog.Cancel>
            <Button
              variant="primary"
              disabled={review === null || review.busy}
              onClick={() => {
                proceed();
              }}
            >
              {review?.mode === 'commit' ? 'Commit anyway' : 'Save anyway'}
            </Button>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
