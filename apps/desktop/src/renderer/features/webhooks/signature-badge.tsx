/** A capture row's verdict (webhook-signatures §4): ✓, ✗ with the reason on hover, and *401*. */
import { REASON_TEXT } from './signature-text.js';
import type { CaptureSignatureWire } from '../../../shared/wire-types.js';

export function SignatureBadge({
  signature,
  rejected,
}: {
  readonly signature: CaptureSignatureWire | null | undefined;
  readonly rejected: boolean | undefined;
}) {
  if (signature === null || signature === undefined) return null;
  const verified = signature.verdict === 'verified';
  return (
    <>
      <span
        data-testid="capture-signature-badge"
        data-verdict={signature.verdict}
        title={verified ? 'Signature verified' : `Signature: ${REASON_TEXT[signature.reason ?? 'key-error']}`}
        className={`shrink-0 font-medium ${verified ? 'text-status-success' : 'text-status-danger'}`}
      >
        {verified ? '✓' : '✗'}
      </span>
      {rejected === true && (
        <span
          data-testid="capture-rejected"
          title="Answered 401 (rejected: unverified)"
          className="shrink-0 rounded bg-surface-sunken px-1 font-mono text-status-danger"
        >
          401
        </span>
      )}
    </>
  );
}
