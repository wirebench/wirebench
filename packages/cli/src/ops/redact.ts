/**
 * The one redaction step every op result passes (spec §2.2): the engine's pattern redactors where a
 * header, URL or body is built, then every secret value the call resolved, masked everywhere.
 */
import { createSecretMasker, REDACTED_MARKER, redactStructuredBody, redactUrl, redactXml } from '@wirebench/engine';
import { maskDeep } from '../reporters/mask.js';
import { OpsError } from './errors.js';

/** A body as an op returns it: a WS-Security password or a JSON/form secret key masked by pattern. */
export function redactBody(text: string, contentType: string | undefined): string {
  const xml = contentType?.toLowerCase().includes('xml') === true || text.trimStart().startsWith('<');
  return xml ? redactXml(text, { show: false }) : redactStructuredBody(text, contentType, { show: false });
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
  return text.replace(/\b(?:https?|wss?):\/\/\S+/gi, (found) => {
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
