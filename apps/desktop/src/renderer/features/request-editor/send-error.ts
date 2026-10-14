/**
 * What a failed send says to the person who sent it: a plain title, how loud it should be, and the
 * one hint that points at the fix.
 *
 * The code stays the machine-readable fact (it is still shown, small, under the message), but it is
 * not the headline: `connection-refused` tells a developer less than "Connection refused" plus
 * "nothing is listening at that host and port". Kept free of React and of any protocol so the
 * response pane of every request kind can read it.
 */

/** The shape of a send's error as the renderer holds it (`IpcError`), restated so this stays leaf code. */
export interface SendErrorLike {
  readonly code: string;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>> | undefined;
}

/**
 * The hint under the message. `timeout` and `unresolved` carry what the panel turns into links:
 * the limit that was hit, and each reference nothing resolved.
 */
export type SendErrorHint =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'timeout'; readonly timeoutMs: number | undefined }
  | { readonly kind: 'unresolved'; readonly refs: readonly string[] };

export interface SendErrorView {
  readonly title: string;
  /** `neutral` for the person's own choice (a cancel, a declined prompt), never a failure colour. */
  readonly tone: 'danger' | 'neutral';
  readonly hint: SendErrorHint | undefined;
}

/** Codes that record a choice the person made, not something that went wrong. */
const CHOSEN = new Set(['aborted', 'send-declined']);

/**
 * Whether a send that ended this way is the person's own doing: a cancel, or a protected
 * environment's prompt they declined. Neither is a Problem, and neither is drawn in red.
 */
export function isChosenOutcome(code: string): boolean {
  return CHOSEN.has(code);
}

const TEXT_HINTS: Readonly<Record<string, { readonly title: string; readonly hint?: string }>> = {
  aborted: { title: 'Cancelled' },
  'send-declined': { title: 'Not sent' },
  'connection-refused': {
    title: 'Connection refused',
    hint: 'Nothing is listening at that host and port. Check the server is running and the port is right.',
  },
  dns: {
    title: 'Host not found',
    hint: 'The host name did not resolve. Check its spelling, or the network and VPN this machine is on.',
  },
  tls: {
    title: 'TLS handshake failed',
    hint: 'The secure connection could not be set up. Check the server speaks https on that port, and the client certificate if one is set.',
  },
  'tls-untrusted': { title: 'Certificate not trusted' },
  proxy: { title: 'Proxy connection failed', hint: 'Check the proxy settings for this request.' },
  network: { title: 'Network error' },
  'too-large': { title: 'Response too large' },
  'too-many-redirects': { title: 'Too many redirects' },
  'invalid-url': { title: 'Invalid URL', hint: 'A URL needs a scheme and a host, such as https://api.example.com.' },
  'rest-url-incomplete': { title: 'Incomplete URL' },
  'script-type-error': { title: 'Script type errors' },
};

/** `${name}` for a reference, whether it arrived with its braces or without them. */
export function referenceText(ref: string): string {
  return ref.startsWith('${') ? ref : `\${${ref}}`;
}

/** A whole `${…}` reference: a malformed one (an unclosed `${`) names nothing a link could find. */
const WHOLE_REFERENCE = /^\$\{[^}]+\}$/;

/** The unresolved references an `…-unresolved-properties` error names, from its details or its message. */
function unresolvedRefs(error: SendErrorLike): readonly string[] {
  const listed = error.details?.['unresolved'];
  if (Array.isArray(listed)) {
    const refs = listed
      .filter((ref): ref is string => typeof ref === 'string')
      .map(referenceText)
      .filter((ref) => WHOLE_REFERENCE.test(ref));
    if (refs.length > 0) {
      return [...new Set(refs)];
    }
  }
  return [...new Set(error.message.match(/\$\{[^}]*\}/g) ?? [])];
}

/** The title, tone and hint for one failed send. */
export function describeSendError(error: SendErrorLike): SendErrorView {
  if (error.code.endsWith('-unresolved-properties')) {
    return {
      title: 'Unresolved variables',
      tone: 'danger',
      hint: { kind: 'unresolved', refs: unresolvedRefs(error) },
    };
  }
  if (error.code === 'timeout') {
    const limit = error.details?.['timeoutMs'];
    return {
      title: 'Timed out',
      tone: 'danger',
      hint: { kind: 'timeout', timeoutMs: typeof limit === 'number' ? limit : undefined },
    };
  }
  const known = TEXT_HINTS[error.code];
  return {
    title: known?.title ?? 'Send failed',
    tone: isChosenOutcome(error.code) ? 'neutral' : 'danger',
    hint: known?.hint !== undefined ? { kind: 'text', text: known.hint } : undefined,
  };
}

/** `30 s`, `1.5 s` or `800 ms`: a limit as a person would say it. */
export function formatLimit(ms: number): string {
  if (ms < 1000) {
    return `${String(ms)} ms`;
  }
  const seconds = ms / 1000;
  return `${Number.isInteger(seconds) ? String(seconds) : seconds.toFixed(1)} s`;
}
