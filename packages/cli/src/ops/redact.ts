/**
 * The one redaction step every op result passes (spec §2.2): the engine's pattern redactors where a
 * header, URL or body is built, then every secret value the call resolved, masked everywhere.
 */
import {
  createSecretMasker,
  isSensitiveHeaderName,
  REDACTED_MARKER,
  redactStructuredBody,
  redactUrl,
  redactXml,
  SECRET_BODY_KEYS,
} from '@wirebench/engine';
import type { AssertionResult, BaselineReport, StepAssertion } from '@wirebench/engine';
import { maskDeep } from '../reporters/mask.js';
import { OpsError } from './errors.js';

/** Whether a body is read as XML: its content type says so, or it starts with a tag. */
export function isXmlBody(text: string, contentType: string | undefined): boolean {
  return contentType?.toLowerCase().includes('xml') === true || text.trimStart().startsWith('<');
}

/** A body as an op returns it: a WS-Security password or a JSON/form secret key masked by pattern. */
export function redactBody(text: string, contentType: string | undefined): string {
  return isXmlBody(text, contentType)
    ? redactXml(text, { show: false })
    : redactStructuredBody(text, contentType, { show: false });
}

/**
 * Every string in `value`, at any depth, with every revealed secret masked. Ops must return plain
 * JSON values: `maskDeep` rebuilds objects and arrays, so a Date, Map or Buffer would not survive.
 */
export function redactResult<R>(value: R, revealed: ReadonlySet<string>): R {
  return maskDeep(value, createSecretMasker([...revealed])) as R;
}

/** A URL `new URL` cannot parse: its `user:pass@` and its query values are stripped by pattern. */
function stripMalformedUrl(url: string): string {
  return url.replace(/(\/\/)[^/?#@\s]*@/, '$1').replace(/([?&][^=&#?\s]*=)[^&#\s]*/g, `$1${REDACTED_MARKER}`);
}

/**
 * `text` with every `http(s)://` and `ws(s)://` URL in it redacted as the engine redacts a logged URL (a password
 * and a credential-named query parameter masked). Transport errors quote the URL they failed on.
 */
export function redactUrlsInText(text: string): string {
  // A URL ends at a quote, an angle bracket, a backslash or a backtick too: in JSON, XML or code it is
  // followed by the text around it, which must not be taken for part of it.
  return text.replace(/\b(?:https?|wss?):\/\/[^\s"'<>\\`]+/gi, (found) => {
    try {
      new URL(found);
    } catch {
      return stripMalformedUrl(found);
    }
    return redactUrl(found);
  });
}

/**
 * The error with its message and details masked (spec §2.2). `details.request` is dropped: an engine
 * transport error carries the failed request unredacted (full URL, final headers, body), and no op
 * output needs it. URLs quoted in the message or in a detail are redacted, then every revealed
 * secret is masked.
 */
export function redactError(error: OpsError, revealed: ReadonlySet<string>): OpsError {
  const secrets = createSecretMasker([...revealed]);
  const mask = (text: string): string => secrets(redactUrlsInText(text));
  let details: Readonly<Record<string, unknown>> | undefined;
  if (error.details !== undefined) {
    const rest = Object.fromEntries(Object.entries(error.details).filter(([key]) => key !== 'request'));
    details = maskDeep(rest, mask) as Readonly<Record<string, unknown>>;
  }
  return new OpsError(error.code, mask(error.message), details);
}

const SECRET_KEYS = new Set(SECRET_BODY_KEYS);

/** The last name in a JSONPath or XPath expression: `token` in `$.data.token`, `$['token']`, `//ns:token/text()`. */
function lastSegment(path: string): string | undefined {
  return path
    .replace(/\/text\(\)\s*$/, '')
    .match(/[A-Za-z_][\w-]*/g)
    ?.at(-1);
}

/** Whether a JSONPath or XPath expression reads a value under a secret key (`$.token`, `//Password`). */
function readsSecretKey(path: string): boolean {
  const last = lastSegment(path);
  return last !== undefined && SECRET_KEYS.has(last.toLowerCase());
}

/** A secret key from the engine's list, in quotes: what is left of a JSON object cut short. */
const QUOTED_SECRET_KEY = new RegExp(`["'](?:${SECRET_BODY_KEYS.join('|')})["']`, 'i');

function parsesAsJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * A value an assertion read, through the body redactors: a node or object it matched can hold a
 * credential below it (`$.auth` is `{"token":"…"}`, `//Header` holds a `wsse:Password`). XML goes by
 * a leading `<`, JSON by parsing. What neither reads whole, such as a value the engine cut at 200
 * characters, is shown as the marker when it still has a `Password` element left open or a quoted
 * secret key in it.
 */
function redactValue(text: string): string {
  if (text.trimStart().startsWith('<')) {
    const xml = redactXml(text, { show: false });
    const opened = xml.match(/<(?:[\w-]+:)?Password\b/gi)?.length ?? 0;
    const closed = xml.match(/<\/(?:[\w-]+:)?Password>/gi)?.length ?? 0;
    return opened > closed ? REDACTED_MARKER : xml;
  }
  if (parsesAsJson(text)) {
    return redactStructuredBody(text, 'application/json', { show: false });
  }
  return QUOTED_SECRET_KEY.test(text) ? REDACTED_MARKER : text;
}

/** A callback check's label (`header Set-Cookie`, or a body path) names a credential. */
function secretLabel(label: string): boolean {
  return label.startsWith('header ') ? isSensitiveHeaderName(label.slice('header '.length)) : readsSecretKey(label);
}

/**
 * A callback result's message with each `<label>: expected …, got "<value>"` whose label names a
 * credential showing the marker for the value. The engine joins its reasons as
 * `matched <id>, but <reason>; <reason>`.
 */
function maskCallbackValues(message: string): string {
  return message.replace(/, got ("(?:[^"\\]|\\.)*")/g, (whole: string, quoted: string, offset: number) => {
    const expectedAt = message.lastIndexOf(': expected ', offset);
    if (expectedAt < 0) {
      return whole;
    }
    const reason = message.lastIndexOf('; ', expectedAt);
    const first = message.lastIndexOf(', but ', expectedAt);
    const start = Math.max(reason < 0 ? 0 : reason + '; '.length, first < 0 ? 0 : first + ', but '.length);
    if (secretLabel(message.slice(start, expectedAt))) {
      return `, got ${REDACTED_MARKER}`;
    }
    // The value may be an object or a node holding a credential further down.
    const value = JSON.parse(quoted) as string;
    const redacted = redactValue(value);
    return redacted === value ? whole : `, got ${JSON.stringify(redacted)}`;
  });
}

/** Whether a result's `actual` is a credential's value: a sensitive header, or a secret-keyed path. */
function hidesActual(result: AssertionResult, own: StepAssertion | undefined): boolean {
  if (result.type === 'header') {
    // Unpaired, the header's name is unknown: hide it rather than guess.
    return own?.type !== 'header' || (own.exists === undefined && isSensitiveHeaderName(own.header));
  }
  if (result.type === 'match') {
    return own?.type !== 'match' || (own.exists === undefined && readsSecretKey(own.expression));
  }
  return false;
}

/** The value an assertion read, as an op shows it. */
function actualOf(result: AssertionResult, own: StepAssertion | undefined, actual: string): string {
  if (hidesActual(result, own)) {
    return REDACTED_MARKER;
  }
  return redactUrlsInText(result.type === 'match' ? redactValue(actual) : actual);
}

type BaselineChange = NonNullable<BaselineReport['changes']>[number];

/** Changes the engine lists in a failed `baseline` assertion's message. */
const BASELINE_MESSAGE_CHANGES = 20;

/**
 * Whether a baseline change's path lies under a secret key: any name in it, as JSON Pointer (`/token`,
 * `/token/0`, `/auth/token`) or as the XML diff writes it (`/Envelope/Body/Login/Password[1]`, an
 * attribute's `@name`, a `prefix:` kept). Any name, not only the last: the body redactors hide the
 * whole value under a secret key, so a change inside it (`/token/expires`) is hidden too.
 */
function underSecretKey(path: string): boolean {
  return path
    .split('/')
    .map((segment) =>
      segment
        .replace(/~1/g, '/')
        .replace(/~0/g, '~')
        .replace(/\[\d+\]$/, '')
        .replace(/^@/, '')
        .replace(/^[\w.-]+:/, '')
        .toLowerCase(),
    )
    .some((name) => SECRET_KEYS.has(name));
}

/** A value a baseline change shows: JSON-encoded or XML text, through the body redactors. */
function baselineValue(value: string): string {
  return redactUrlsInText(redactValue(value));
}

function redactChange(change: BaselineChange): BaselineChange {
  const hide = underSecretKey(change.path);
  const shown = (value: string): string => (hide ? REDACTED_MARKER : baselineValue(value));
  return {
    ...change,
    ...(change.expected !== undefined ? { expected: shown(change.expected) } : {}),
    ...(change.actual !== undefined ? { actual: shown(change.actual) } : {}),
  };
}

/**
 * A baseline comparison as an op returns it (#218): each change's values through the same pattern
 * redaction as the body and the `match` assertions — the marker on both sides under a secret key,
 * the body redactors on anything else — and URLs in the fallback error redacted.
 */
export function redactBaseline(report: BaselineReport): BaselineReport {
  return {
    ...report,
    ...(report.changes !== undefined ? { changes: report.changes.map(redactChange) } : {}),
    ...(report.error !== undefined ? { error: redactUrlsInText(report.error) } : {}),
  };
}

/** One line of a failed baseline assertion's message, as the engine writes it. */
function changeLine(change: BaselineChange): string {
  if (change.kind === 'added') return `added ${change.path}: ${change.actual ?? ''}`;
  if (change.kind === 'removed') return `removed ${change.path}: ${change.expected ?? ''}`;
  return `changed ${change.path}: ${change.expected ?? ''} → ${change.actual ?? ''}`;
}

/**
 * A failed baseline assertion's message rebuilt from the redacted changes, so it carries no raw value:
 * the engine's leading `compared as text:` line (URLs redacted) and trailing `… and N more` line kept.
 */
function baselineMessage(message: string, baseline: BaselineReport | undefined): string {
  const lines = message.split('\n');
  const first = lines[0] ?? '';
  const last = lines.at(-1) ?? '';
  return [
    ...(first.startsWith('compared as text: ') ? [redactUrlsInText(first)] : []),
    ...(baseline?.changes ?? []).slice(0, BASELINE_MESSAGE_CHANGES).map(changeLine),
    ...(/^… and \d+ more$/.test(last) ? [last] : []),
  ].join('\n');
}

/**
 * Assertion results as an op returns them (spec §2.2): URLs in every text redacted by pattern, and
 * the value a header or `match` assertion read shown as the marker when it is a credential — a
 * sensitive header, or a JSONPath/XPath whose last name is a secret key. `assertions` are the
 * request's own, in order: the run reports the immediate ones first, then callbacks, then script
 * tests; a `baseline` result (#218) is the run's own and pairs with none. A failed one's message is
 * rebuilt from `baseline`, the comparison already through {@link redactBaseline}.
 */
export function redactAssertions(
  results: readonly AssertionResult[],
  assertions: readonly StepAssertion[],
  baseline?: BaselineReport,
): AssertionResult[] {
  const immediate = assertions.filter((assertion) => assertion.type !== 'callback');
  let next = 0;
  return results.map((result) => {
    let own: StepAssertion | undefined;
    if (result.type !== 'callback' && result.type !== 'script' && result.type !== 'baseline') {
      own = immediate[next];
      next += 1;
    }
    let message: string | undefined;
    if (result.message !== undefined) {
      if (result.type === 'baseline' && result.outcome === 'failed') {
        message = baselineMessage(result.message, baseline);
      } else {
        message = redactUrlsInText(result.type === 'callback' ? maskCallbackValues(result.message) : result.message);
      }
    }
    return {
      ...result,
      label: redactUrlsInText(result.label),
      ...(result.expected !== undefined ? { expected: redactUrlsInText(result.expected) } : {}),
      ...(result.actual !== undefined ? { actual: actualOf(result, own, result.actual) } : {}),
      ...(message !== undefined ? { message } : {}),
    };
  });
}
