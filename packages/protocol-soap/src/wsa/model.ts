/**
 * The WS-Addressing configuration model: what a request (or its interface) says about the
 * `wsa:*` headers a send should carry, and how the two levels combine.
 *
 * Both levels hold the same shape. A request that defines no `wsa` at all inherits its
 * interface's configuration wholesale; a request that defines one overrides the interface
 * field by field, so a request can change only the `Action` and still follow the interface
 * for everything else.
 */

/** The WS-Addressing specification version a header block is written in. */
export type WsaVersion = '2005/08' | '2004/08';

/**
 * Whether (and how) a `soap:mustUnderstand` attribute is put on every `wsa:*` header:
 * `'none'` writes no attribute at all, and is the default.
 */
export type WsaMustUnderstand = 'none' | 'true' | 'false';

/** One level's WS-Addressing settings. */
export interface WsaConfig {
  readonly enabled: boolean;
  readonly version: WsaVersion;
  readonly mustUnderstand: WsaMustUnderstand;
  /** Explicit `wsa:Action`; falls back to the SOAPAction and then the WSDL default action. */
  readonly action?: string;
  /** Explicit `wsa:To`; falls back to the endpoint URL when {@link addDefaultTo}. */
  readonly to?: string;
  /**
   * The literal `'auto'` (or any empty value with {@link generateMessageId}) mints a fresh
   * `urn:uuid:`; anything else is sent verbatim, so two sends share one MessageID.
   */
  readonly messageId?: string;
  readonly replyTo?: string;
  readonly from?: string;
  readonly faultTo?: string;
  readonly relatesTo?: string;
  readonly relationshipType?: string;
  readonly addDefaultAction: boolean;
  readonly addDefaultTo: boolean;
  readonly generateMessageId: boolean;
}

/**
 * A partial configuration, as a project file written by an older build may hold. Every key is
 * explicitly `| undefined` so a value parsed by zod (where an absent optional is present as
 * `undefined`) is assignable under `exactOptionalPropertyTypes`.
 */
export type WsaConfigPatch = { readonly [K in keyof WsaConfig]?: WsaConfig[K] | undefined };

/**
 * The v1 defaults. They match what a project file from before the WS-Addressing task holds
 * once the missing fields are filled in, so an old `{ enabled, version }` keeps working.
 */
export const DEFAULT_WSA_CONFIG: WsaConfig = {
  enabled: false,
  version: '2005/08',
  mustUnderstand: 'none',
  addDefaultAction: true,
  addDefaultTo: true,
  generateMessageId: true,
};

/** Copies the keys of `patch` that are actually set onto `base`. */
function merge(base: WsaConfig, patch: WsaConfigPatch | undefined): WsaConfig {
  if (patch === undefined) {
    return base;
  }
  const next: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) {
      next[key] = value;
    }
  }
  return next as unknown as WsaConfig;
}

/**
 * Fills a (possibly partial) configuration out with {@link DEFAULT_WSA_CONFIG}.
 *
 * @param patch the stored configuration, or `undefined`
 */
export function normalizeWsa(patch: WsaConfigPatch | undefined): WsaConfig {
  return merge(DEFAULT_WSA_CONFIG, patch);
}

/**
 * The configuration one send actually runs with: the defaults, then the interface's settings,
 * then the request's own — each level overriding the previous field by field.
 *
 * @param interfaceWsa the interface-level defaults
 * @param requestWsa the request's own overrides, absent when the request inherits
 */
export function effectiveWsa(
  interfaceWsa: WsaConfigPatch | undefined,
  requestWsa: WsaConfigPatch | undefined,
): WsaConfig {
  return merge(merge(DEFAULT_WSA_CONFIG, interfaceWsa), requestWsa);
}
