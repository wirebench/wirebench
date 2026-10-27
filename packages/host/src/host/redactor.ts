/**
 * The secret *values* one host's main handed to a send, and the masking built on them.
 *
 * `GetSecret`'s masking contract says every value a host's getter returns must be masked. The
 * desktop getter (`projectSecretGetter`) records each `${secret:name}` value here with
 * {@link Redactor.recordSecretValue}, main's auth resolution records each credential it resolves with
 * {@link Redactor.recordAuthValues}, and every helper below masks recorded values too — so a
 * `${secret:name}` value sent in an ordinary header, a URL or an envelope, or an API key a server
 * echoes back in a body or a `Location` header, shows as `<redacted>` in the HTTP log and History
 * exactly as an `Authorization` header does. The set lives for the session in one host only, is
 * never shared with another host in the process, and is never written anywhere; with the
 * show-secrets toggle on, values are shown like everything else.
 *
 * The methods are arrow properties so they can be handed on detached (`onSecretValue:
 * redactor.recordSecretValue`).
 */
import {
  createSecretBytesMasker,
  createSecretMasker,
  REDACTED_XML_MARKER,
  redactHeaderPairs as redactHeaderPairsByName,
  redactHeaders as redactHeadersByName,
  redactRawHttp as redactRawHttpByPattern,
  redactStructuredBody as redactStructuredBodyByKey,
  redactUrl as redactUrlByParam,
  redactXml as redactXmlByElement,
} from '@wirebench/engine';
import type { SendAuth } from '@wirebench/engine';

export class Redactor {
  private readonly recorded = new Set<string>();
  private masker: ((text: string) => string) | undefined;
  /** The same, for XML text: it writes the marker escaped, so the document stays well formed. */
  private xmlMasker: ((text: string) => string) | undefined;
  /** The same, over a base64 run of raw bytes: each value's UTF-8 bytes, wherever they sit. */
  private byteMasker: ((base64: string) => string) | undefined;

  /** Adds a secret value main handed out to the set every helper here masks, for the session. */
  readonly recordSecretValue = (value: string): void => {
    if (!this.recorded.has(value)) {
      this.recorded.add(value);
      this.masker = undefined;
      this.xmlMasker = undefined;
      this.byteMasker = undefined;
    }
  };

  /**
   * Records the credential a resolved `auth` puts on the wire, in the form it travels there: an API
   * key's value, a bearer or OAuth2 access token, and Basic's `base64(user:password)`. A server that
   * echoes one back — a reflected query, a redirect's `Location`, an error quoting the header — then
   * has it masked wherever the log or History shows the exchange, not only where the header and
   * parameter rules look.
   *
   * A password is never recorded bare: people choose them, so one is often ordinary text (`admin` in
   * `/admin/users`, `"role":"admin"`), and masking it for the session would rewrite every History
   * line that contains it. Basic's encoded pair is opaque, so it is recorded in its place; NTLM's
   * password never travels at all.
   */
  readonly recordAuthValues = (auth: SendAuth | undefined): void => {
    switch (auth?.type) {
      case 'api-key':
        this.recordSecretValue(auth.value);
        return;
      case 'bearer':
        this.recordSecretValue(auth.token);
        return;
      case 'oauth2':
        this.recordSecretValue(auth.accessToken);
        return;
      case 'jwt':
        this.recordSecretValue(auth.token);
        return;
      case 'basic':
        this.recordSecretValue(Buffer.from(`${auth.username}:${auth.password}`, 'utf-8').toString('base64'));
        return;
      case 'aws-sigv4':
        // The secret key never travels; the key id and a session token do, in a header or the URL.
        this.recordSecretValue(auth.accessKeyId);
        if (auth.sessionToken !== undefined) this.recordSecretValue(auth.sessionToken);
        return;
      default:
        return;
    }
  };

  /**
   * `text` with every recorded value (and its escaped forms) replaced by the redaction marker: the
   * escaped `&lt;redacted&gt;` when `xml` says the text is XML, as `redactXml` writes it, so XML
   * shows one marker however a value was masked.
   */
  private maskRecorded = (text: string, xml = false): string => {
    if (this.recorded.size === 0) {
      return text;
    }
    if (xml) {
      this.xmlMasker ??= createSecretMasker([...this.recorded], { marker: REDACTED_XML_MARKER });
      return this.xmlMasker(text);
    }
    this.masker ??= createSecretMasker([...this.recorded]);
    return this.masker(text);
  };

  /**
   * Whether `value` holds a secret value main has recorded this session, in any form the masker knows
   * (plain, percent-, form-, XML- or JSON-escaped, base64): exactly when masking would change it. A
   * sequence treats a transferred value like that as secret even when its transfer is not marked.
   */
  readonly containsRecordedSecret = (value: string): boolean => {
    return this.maskRecorded(value) !== value;
  };

  /**
   * `text` with every recorded value masked, whatever the show-secrets toggle says: for what is
   * written to disk (a History body), which is always redacted. With `xml`, the marker is written
   * escaped, as in any XML.
   */
  readonly redactSecretValues = (text: string, opts?: { xml?: boolean }): string => {
    return this.maskRecorded(text, opts?.xml === true);
  };

  /**
   * `text` with every recorded value masked unless `show`: for payloads no pattern rule applies to
   * (a WebSocket frame, a gRPC message or status message) on their way to the renderer. With `xml`
   * (decoded XML or HTML), the marker is written escaped, as `redactXml` writes it, so a pretty-printer
   * or an HTML preview sees text rather than a stray tag.
   */
  readonly redactSecretText = (text: string, opts?: { show?: boolean; xml?: boolean }): string => {
    return opts?.show === true ? text : this.maskRecorded(text, opts?.xml === true);
  };

  /**
   * A base64 run of raw bytes with every recorded value's UTF-8 bytes masked unless `show`, whatever
   * the bytes around them are: a protobuf message, where a string field sits between binary tags, or
   * a binary WebSocket frame, whether it carries JSON, MessagePack or CBOR. A run with nothing to
   * mask comes back as the same string, not a re-encoding of it.
   */
  readonly redactSecretBytes = (base64: string, opts?: { show?: boolean }): string => {
    if (opts?.show === true || this.recorded.size === 0) {
      return base64;
    }
    this.byteMasker ??= createSecretBytesMasker([...this.recorded]);
    return this.byteMasker(base64);
  };

  /** See the engine's `redactHeaders`; recorded values are masked in every other header too. */
  readonly redactHeaders = (
    headers: Readonly<Record<string, string>>,
    opts?: { show?: boolean; extraHeaders?: readonly string[] },
  ): Record<string, string> => {
    const out = redactHeadersByName(headers, opts);
    if (opts?.show === true) {
      return out;
    }
    for (const [name, value] of Object.entries(out)) {
      out[name] = this.maskRecorded(value);
    }
    return out;
  };

  /** See the engine's `redactHeaderPairs`; recorded values are masked in every other header too. */
  readonly redactHeaderPairs = (
    pairs: readonly (readonly [string, string])[],
    opts?: { show?: boolean; extraHeaders?: readonly string[] },
  ): [string, string][] => {
    const out = redactHeaderPairsByName(pairs, opts);
    return opts?.show === true ? out : out.map(([name, value]) => [name, this.maskRecorded(value)]);
  };

  /** See the engine's `redactUrl`; recorded values are masked anywhere in the URL too. */
  readonly redactUrl = (url: string, opts?: { show?: boolean; extraParams?: readonly string[] }): string => {
    const out = redactUrlByParam(url, opts);
    return opts?.show === true ? out : this.maskRecorded(out);
  };

  /**
   * See the engine's `redactXml`; recorded values are masked anywhere in the document too, with the
   * escaped marker the element rule writes. A caller that runs this pass over a body it does not know
   * to be XML (an export that masks every body the same way) passes `xml: false`, so a recorded value
   * in JSON or plain text keeps the raw marker.
   */
  readonly redactXml = (text: string, opts?: { show?: boolean; xml?: boolean }): string => {
    const out = redactXmlByElement(text, opts);
    return opts?.show === true ? out : this.maskRecorded(out, opts?.xml !== false);
  };

  /** See the engine's `redactStructuredBody`; recorded values are masked anywhere in the body too. */
  readonly redactStructuredBody = (
    text: string,
    contentType: string | undefined,
    opts?: { show?: boolean },
  ): string => {
    const out = redactStructuredBodyByKey(text, contentType, opts);
    return opts?.show === true ? out : this.maskRecorded(out);
  };

  /** See the engine's `redactRawHttp`; recorded values are masked anywhere in the message too. */
  readonly redactRawHttp = (
    input: string,
    opts?: {
      show?: boolean;
      encoding?: 'text' | 'base64';
      extraParams?: readonly string[];
      extraHeaders?: readonly string[];
    },
  ): string => {
    const out = redactRawHttpByPattern(input, opts);
    if (opts?.show === true || this.recorded.size === 0) {
      return out;
    }
    return opts?.encoding === 'base64' ? this.redactSecretBytes(out) : this.maskRecorded(out);
  };
}
