import { useMemo, useState } from 'react';
import { EmptyState } from '../../../components/empty-state.js';
import { formatBytes } from '../../../lib/format-size.js';

/** Header/body are joined by a bare CRLFCRLF in the reconstructed wire bytes (`raw-capture.ts`). */
const HEAD_BODY_SEPARATOR = '\r\n\r\n';

/** Above this fraction of non-printable bytes, the body is shown as a byte count instead of text. */
const BINARY_RATIO_THRESHOLD = 0.3;

/** `atob`'s "binary string" already maps each byte to the same-valued code unit — exactly the
 * latin1-safe decoding the raw view wants (unlike `decodeBase64Text`, which decodes as UTF-8 and
 * would corrupt a body that isn't valid UTF-8). Returns `undefined` for invalid base64. */
function decodeLatin1(base64: string): string | undefined {
  try {
    return atob(base64);
  } catch {
    return undefined;
  }
}

/** True when `text` looks like binary data rather than something worth rendering as text: any
 * NUL byte, or a high enough ratio of non-printable, non-whitespace characters. */
function looksBinary(text: string): boolean {
  if (text.length === 0) {
    return false;
  }
  let nonPrintable = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    const isPrintable = (code >= 0x20 && code < 0x7f) || code === 0x09 || code === 0x0a || code === 0x0d;
    if (!isPrintable) {
      nonPrintable += 1;
    }
    if (code === 0) {
      return true;
    }
  }
  return nonPrintable / text.length > BINARY_RATIO_THRESHOLD;
}

/** Splits reconstructed raw HTTP bytes into the header block (always shown as text) and the body
 * (shown as text, or as a byte count when it looks binary). */
function renderRaw(text: string): string {
  const separatorIndex = text.indexOf(HEAD_BODY_SEPARATOR);
  if (separatorIndex === -1) {
    return looksBinary(text) ? `<${text.length} bytes of binary>` : text;
  }
  const head = text.slice(0, separatorIndex + HEAD_BODY_SEPARATOR.length);
  const body = text.slice(separatorIndex + HEAD_BODY_SEPARATOR.length);
  if (body.length === 0) {
    return head;
  }
  return looksBinary(body) ? `${head}<${body.length} bytes of binary>` : `${head}${body}`;
}

export interface RawViewProps {
  /** `rawRequestBase64` or `rawResponseBase64` of the exchange to show; `undefined` before a send. */
  readonly base64: string | undefined;
  readonly emptyTitle: string;
  readonly emptyDescription: string;
  /** Accessible name for the raw text region — what e2e specs and AT address it by. */
  readonly ariaLabel: string;
}

/**
 * Read-only view of the exact bytes sent or received: the reconstructed request/status line,
 * headers, and body, exactly as `raw-capture.ts` built them (redaction already applied upstream
 * via the exchange's own `***` masking, which show-secrets governs like everywhere else).
 */
export function RawView({ base64, emptyTitle, emptyDescription, ariaLabel }: RawViewProps) {
  const [copied, setCopied] = useState(false);

  const decoded = useMemo(() => (base64 === undefined ? undefined : decodeLatin1(base64)), [base64]);
  const rendered = useMemo(() => (decoded === undefined ? undefined : renderRaw(decoded)), [decoded]);
  const byteLength = decoded?.length;

  if (base64 === undefined || rendered === undefined) {
    return <EmptyState title={emptyTitle} description={emptyDescription} />;
  }

  const handleCopy = () => {
    void navigator.clipboard.writeText(decoded ?? '');
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-hairline px-3 py-1 text-xs text-fg-muted">
        <span>
          {byteLength !== undefined ? formatBytes(byteLength) : '—'} · secrets are redacted unless Show secrets is on
        </span>
        <button
          type="button"
          onClick={handleCopy}
          className="rounded-sm px-2 py-0.5 text-xs text-fg-subtle hover:bg-surface-hover hover:text-fg-default"
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre
        aria-label={ariaLabel}
        className="min-h-0 flex-1 overflow-auto p-3 font-mono text-sm break-words whitespace-pre-wrap text-fg-default"
      >
        {rendered}
      </pre>
    </div>
  );
}
