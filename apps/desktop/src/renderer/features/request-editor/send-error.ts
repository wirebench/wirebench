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
 * The hint under the message. `timeout`, `unresolved` and `unclosed` carry what the panel turns into
 * links: the limit that was hit, each reference nothing resolved, and each `${` never closed (from
 * the `${` to the end of its text, as the engine reports it).
 */
export type SendErrorHint =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'timeout'; readonly timeoutMs: number | undefined }
  | { readonly kind: 'unresolved'; readonly refs: readonly string[] }
  | { readonly kind: 'unclosed'; readonly fragments: readonly string[] };

export interface SendErrorView {
  /** Short, for a status row or a log cell: "Connection refused". */
  readonly title: string;
  /** The panel's heading: the title with the target in it when the error names one ("Couldn't connect to 127.0.0.1:9"). */
  readonly headline: string;
  /** The message, when it says more than the headline; undefined when it only restates it. */
  readonly detail: string | undefined;
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

/**
 * Codes for a send the network could not complete: nothing in the project is wrong, and the panel
 * already explains it with a hint and Retry, so it is never a Problem (owner ruling, #635). An
 * untrusted certificate is not one of them: its fix is the project's trust setting.
 */
const TRANSPORT = new Set(['connection-refused', 'dns', 'timeout', 'tls', 'proxy', 'network']);

/** Whether a failed send belongs in Problems: not the person's own choice, and not the network's doing. */
export function isProblemOutcome(code: string): boolean {
  return !CHOSEN.has(code) && !TRANSPORT.has(code);
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

/** The messages the engine gives a failure that say nothing its title does not. */
const STOCK_MESSAGES: Readonly<Record<string, string>> = {
  aborted: 'The request was aborted.',
  'connection-refused': 'Connection refused.',
  dns: 'DNS lookup failed.',
  timeout: 'The request timed out.',
  tls: 'TLS/certificate error.',
  proxy: 'Proxy connection failed.',
};

/** The message without what the title already says: nothing when it is stock, else less a leading `Title: `. */
function detailOf(error: SendErrorLike, title: string): string | undefined {
  const message = error.message.trim();
  if (message === '' || message === STOCK_MESSAGES[error.code]) {
    return undefined;
  }
  const prefix = `${title}: `;
  if (message.toLowerCase().startsWith(prefix.toLowerCase())) {
    return message.slice(prefix.length);
  }
  return message.replace(/\.$/, '').toLowerCase() === title.toLowerCase() ? undefined : message;
}

/** A detail the engine attached, when it is a non-empty string. */
function detailText(error: SendErrorLike, key: string): string | undefined {
  const value = error.details?.[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** The heading that names what to check: the host and port refused, the host that did not resolve. */
function headlineOf(error: SendErrorLike, title: string): string {
  const target = detailText(error, 'target');
  if (error.code === 'connection-refused' && target !== undefined) {
    return `Couldn't connect to ${target}`;
  }
  const host = detailText(error, 'host');
  if (error.code === 'dns' && host !== undefined) {
    return `Host ${host} not found`;
  }
  return title;
}

/** `${name}` for a reference, whether it arrived with its braces or without them. */
export function referenceText(ref: string): string {
  return ref.startsWith('${') ? ref : `\${${ref}}`;
}

/** A whole `${…}` reference: a malformed one (an unclosed `${`) names nothing a link could find. */
const WHOLE_REFERENCE = /^\$\{[^}]+\}$/;

/** Whether a reported reference is a `${` its text never closes, the engine's `malformed` ref. */
function isUnclosed(ref: string): boolean {
  if (!ref.startsWith('${')) {
    return false;
  }
  let depth = 0;
  for (let at = 0; at < ref.length; at += 1) {
    if (ref.startsWith('${', at)) {
      depth += 1;
      at += 1;
    } else if (ref[at] === '}') {
      depth -= 1;
    }
  }
  return depth > 0;
}

/** The unresolved references an `…-unresolved-properties` error names, from its details or its message. */
function unresolvedRefs(error: SendErrorLike): readonly string[] {
  const listed = error.details?.['unresolved'];
  if (Array.isArray(listed)) {
    const refs = listed
      .filter((ref): ref is string => typeof ref === 'string')
      .map(referenceText)
      .filter((ref) => WHOLE_REFERENCE.test(ref) && !isUnclosed(ref));
    if (refs.length > 0) {
      return [...new Set(refs)];
    }
  }
  return [...new Set((error.message.match(/\$\{[^}]*\}/g) ?? []).filter((ref) => !isUnclosed(ref)))];
}

/** The title, headline, detail, tone and hint for one failed send. */
export function describeSendError(error: SendErrorLike): SendErrorView {
  const view = describeBare(error);
  return {
    ...view,
    headline: headlineOf(error, view.title),
    // "references nothing resolves: ${$rand" says less about an unclosed `${` than its hint does.
    detail: view.hint?.kind === 'unclosed' ? undefined : detailOf(error, view.title),
  };
}

function describeBare(error: SendErrorLike): Omit<SendErrorView, 'headline' | 'detail'> {
  if (error.code.endsWith('-unresolved-properties')) {
    const refs = unresolvedRefs(error);
    // A `${` never closed is a typing slip, not a variable missing from the environment. Missing
    // variables are named first when there are both: the list links each to its field.
    const listed = error.details?.['unresolved'];
    const fragments = Array.isArray(listed)
      ? [...new Set(listed.filter((ref): ref is string => typeof ref === 'string' && isUnclosed(ref)))]
      : [];
    if (refs.length === 0 && fragments.length > 0) {
      return { title: 'Unclosed ${', tone: 'danger', hint: { kind: 'unclosed', fragments } };
    }
    return {
      title: 'Unresolved variables',
      tone: 'danger',
      hint: { kind: 'unresolved', refs },
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

/** A failed send as Problems words it: the plain title, then the message, never the bare code first. */
export function sendProblemText(error: SendErrorLike): string {
  const { title } = describeSendError(error);
  const message = error.message.trim();
  if (message === '' || message.replace(/\.$/, '').toLowerCase() === title.toLowerCase()) {
    return title;
  }
  return `${title}: ${message}`;
}
