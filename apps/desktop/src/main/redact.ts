/**
 * Redaction lives in the engine so the CLI runner's reports are masked by the same rules as the
 * app's HTTP log. This module stays as the desktop's import path for it, and adds the one thing
 * the pattern rules cannot know: the secret *values* main itself handed to a send.
 *
 * `GetSecret`'s masking contract says every value a host's getter returns must be masked. The
 * desktop getter (`projectSecretGetter`) records each `${secret:name}` value here with
 * {@link recordSecretValue} (auth values are masked by the rules for where they go), and
 * every helper below masks recorded values too — so a `${secret:name}` value sent in an ordinary
 * header, a URL or an envelope shows as `<redacted>` in the HTTP log and History exactly as an
 * `Authorization` header does. The set lives for the session in main only, and is never written
 * anywhere; with the show-secrets toggle on, values are shown like everything else.
 */
import {
  createSecretMasker,
  redactHeaderPairs as redactHeaderPairsByName,
  redactHeaders as redactHeadersByName,
  redactRawHttp as redactRawHttpByPattern,
  redactStructuredBody as redactStructuredBodyByKey,
  redactUrl as redactUrlByParam,
  redactXml as redactXmlByElement,
} from '@wirebench/engine';

export { REDACTED_MARKER, SECRET_BODY_KEYS, containsRedaction, redactResponseAttachments } from '@wirebench/engine';

const recorded = new Set<string>();
let masker: ((text: string) => string) | undefined;
/** The same, over raw bytes read as latin1: each value as its UTF-8 bytes would read that way. */
let byteMasker: ((text: string) => string) | undefined;

/** Adds a secret value main handed out to the set every helper here masks, for the session. */
export function recordSecretValue(value: string): void {
  if (!recorded.has(value)) {
    recorded.add(value);
    masker = undefined;
    byteMasker = undefined;
  }
}

/** `text` with every recorded value (and its escaped forms) replaced by the redaction marker. */
function maskRecorded(text: string): string {
  if (recorded.size === 0) {
    return text;
  }
  masker ??= createSecretMasker([...recorded]);
  return masker(text);
}

/**
 * `text` with every recorded value masked, whatever the show-secrets toggle says: for what is
 * written to disk (a History body), which is always redacted.
 */
export function redactSecretValues(text: string): string {
  return maskRecorded(text);
}

/**
 * `text` with every recorded value masked unless `show`: for payloads no pattern rule applies to
 * (a WebSocket frame, a gRPC request message) on their way to the renderer.
 */
export function redactSecretText(text: string, opts?: { show?: boolean }): string {
  return opts?.show === true ? text : maskRecorded(text);
}

/** See the engine's `redactHeaders`; recorded values are masked in every other header too. */
export function redactHeaders(
  headers: Readonly<Record<string, string>>,
  opts?: { show?: boolean; extraHeaders?: readonly string[] },
): Record<string, string> {
  const out = redactHeadersByName(headers, opts);
  if (opts?.show === true) {
    return out;
  }
  for (const [name, value] of Object.entries(out)) {
    out[name] = maskRecorded(value);
  }
  return out;
}

/** See the engine's `redactHeaderPairs`; recorded values are masked in every other header too. */
export function redactHeaderPairs(
  pairs: readonly (readonly [string, string])[],
  opts?: { show?: boolean; extraHeaders?: readonly string[] },
): [string, string][] {
  const out = redactHeaderPairsByName(pairs, opts);
  return opts?.show === true ? out : out.map(([name, value]) => [name, maskRecorded(value)]);
}

/** See the engine's `redactUrl`; recorded values are masked anywhere in the URL too. */
export function redactUrl(url: string, opts?: { show?: boolean; extraParams?: readonly string[] }): string {
  const out = redactUrlByParam(url, opts);
  return opts?.show === true ? out : maskRecorded(out);
}

/** See the engine's `redactXml`; recorded values are masked anywhere in the document too. */
export function redactXml(text: string, opts?: { show?: boolean }): string {
  const out = redactXmlByElement(text, opts);
  return opts?.show === true ? out : maskRecorded(out);
}

/** See the engine's `redactStructuredBody`; recorded values are masked anywhere in the body too. */
export function redactStructuredBody(text: string, contentType: string | undefined, opts?: { show?: boolean }): string {
  const out = redactStructuredBodyByKey(text, contentType, opts);
  return opts?.show === true ? out : maskRecorded(out);
}

/** See the engine's `redactRawHttp`; recorded values are masked anywhere in the message too. */
export function redactRawHttp(
  input: string,
  opts?: {
    show?: boolean;
    encoding?: 'text' | 'base64';
    extraParams?: readonly string[];
    extraHeaders?: readonly string[];
  },
): string {
  const out = redactRawHttpByPattern(input, opts);
  if (opts?.show === true || recorded.size === 0) {
    return out;
  }
  if (opts?.encoding !== 'base64') {
    return maskRecorded(out);
  }
  // Read as latin1 so bytes that are not UTF-8 (a binary body) survive the round trip unchanged.
  byteMasker ??= createSecretMasker([...recorded].map((value) => Buffer.from(value, 'utf8').toString('latin1')));
  const text = Buffer.from(out, 'base64').toString('latin1');
  const masked = byteMasker(text);
  return masked === text ? out : Buffer.from(masked, 'latin1').toString('base64');
}
