/**
 * The application's global preferences: the settings that live with the *user*, not with a
 * project, and are persisted by the desktop app in `userData/preferences.yaml`.
 *
 * Everything here is deliberately plain data — the engine never reads a file for it. The
 * desktop's `PreferencesService` loads/merges/persists a document; the engine consumes the
 * merged object (see `send-options.ts`).
 *
 * Some sections are persisted and shown before they are wired to behaviour: `proxy` and `ssl`
 * become effective with the connection settings task.
 * They are modelled now so a preferences file written today survives those tasks unchanged.
 */

import { z } from 'zod';

/** HTTP transport preferences applied to every send. */
export interface HttpPreferences {
  /** Reserved: only HTTP/1.1 is implemented. */
  readonly version: '1.1';
  /** `User-Agent` added to a request that does not set one itself. */
  readonly userAgent: string;
  /** `gzip` compresses the request body and sets `Content-Encoding: gzip`. */
  readonly requestCompression: 'none' | 'gzip';
  /** Advertise `Accept-Encoding: gzip, deflate` so servers may compress the response. */
  readonly responseCompression: boolean;
  /** Send `Connection: close` instead of reusing the keep-alive pool. */
  readonly closeConnections: boolean;
  /** Body size (bytes) above which chunked transfer would be used. Reserved. */
  readonly chunkingThreshold: number;
  /** Socket timeout used when neither the request nor the project sets one. */
  readonly socketTimeoutMs: number;
  /** Maximum simultaneous connections per host. Reserved. */
  readonly maxConnections: number;
  /**
   * Offer HTTP/2 in the TLS ALPN handshake. Off by default: HTTP/2 changes what the raw view
   * can faithfully reconstruct, and most SOAP stacks speak HTTP/1.1 only.
   */
  readonly allowH2: boolean;
}

/** Proxy preferences, consulted for every send by `resolveProxyFor`. */
export interface ProxyPreferences {
  readonly mode: 'none' | 'system' | 'manual';
  readonly host?: string;
  readonly port?: number;
  readonly username?: string;
  /** Opaque reference into the OS-keychain-backed secret store. Never a password. */
  readonly passwordRef?: string;
  /** Hosts that bypass the proxy. */
  readonly excludes: readonly string[];
}

/** TLS preferences, folded into every send's `TlsOptions`. */
export interface SslPreferences {
  readonly minVersion: 'TLSv1.2' | 'TLSv1.3';
  /** Absolute path to a PEM bundle of extra trust anchors; read in main, never by the engine. */
  readonly caBundlePath?: string;
  /**
   * Set by the desktop main process when, and only when, {@link caBundlePath} came from a
   * native file picker it ran itself. It is the evidence that the path was *chosen* rather than
   * typed, pasted over IPC or edited into `preferences.yaml` by hand — and main re-records the
   * path as a read pick at startup only when it is present, so a hand-edited file adds no trust
   * until the bundle is picked again. Never settable through `preferences.update`.
   */
  readonly caBundlePickedByMain?: boolean;
  /** Id of a `wss/keystores.yaml` entry used as the client identity when a request selects none. */
  readonly clientKeystoreRef?: string;
  /**
   * Always `false`: trusting every certificate globally is not an option Wirebench offers.
   * The only escape hatch is an endpoint's `trustInvalid`, which is badged in red wherever
   * that endpoint appears.
   */
  readonly trustAll: false;
}

/** WSDL import and request-generation preferences. */
export interface WsdlPreferences {
  /** Default `cacheDefinition` for a newly imported interface. */
  readonly cacheDefinitions: boolean;
  /** Pretty-print generated envelopes. */
  readonly prettyPrint: boolean;
  /** Fill generated leaves with sample values rather than `?` placeholders. */
  readonly sampleValues: boolean;
  /** Annotate generated elements with their schema type. */
  readonly typeComments: boolean;
  /** Include `minOccurs="0"` particles when generating. */
  readonly includeOptional: boolean;
  /** Treat schema problems as errors rather than warnings. */
  readonly strictSchema: boolean;
  /** Store cached definitions compressed. */
  readonly compression: boolean;
  /** Name a generated request after its binding as well as its operation. */
  readonly nameWithBinding: boolean;
}

/** WS-I Basic Profile validation preferences. */
export interface WsiPreferences {
  readonly verbose: boolean;
  readonly profile: 'BP1.1';
}

/** Editor preferences, applied to every XML editor and to formatting. */
export interface EditorPreferences {
  readonly fontFamily?: string;
  readonly fontSize: number;
  /** Indentation width, also used as the pretty-printer's indent. */
  readonly tabSize: number;
  readonly lineNumbers: boolean;
  readonly wordWrap: boolean;
  /** Validate the envelope against the schema before sending. */
  readonly autoValidateOnSend: boolean;
  /** Pretty-print responses in the response pane. */
  readonly autoFormatResponses: boolean;
  /**
   * Write a project's edits out on a short debounce instead of waiting to be told to.
   *
   * Off by default: an edit is the user's to commit, and a tool that writes to their project
   * folder behind them is a tool they cannot experiment in. Closing a workspace and quitting
   * still save whatever is outstanding — this chooses when routine edits land, not whether
   * work can be lost.
   */
  readonly autosave: boolean;
}

/** How a request editor arranges its panes. Mirrors the renderer's layout snapshot. */
export interface LayoutPreference {
  readonly orientation: 'side-by-side' | 'stacked';
  readonly mode: 'split' | 'tabs';
}

/** Shell/appearance preferences. */
export interface UiPreferences {
  readonly theme: 'dark' | 'light' | 'system';
  readonly defaultLayout: LayoutPreference;
  readonly confirmOnDelete: boolean;
  /** How many history entries are kept per project. */
  readonly historyCap: number;
}

/**
 * Software-update preferences. `checkOnLaunch` is off by default and stays off until the user
 * turns it on: Wirebench contacts the release feed when asked, not when started.
 */
export interface UpdatePreferences {
  /** Check GitHub Releases for a newer version once, shortly after the app starts. */
  readonly checkOnLaunch: boolean;
}

/** The whole preferences document. */
export interface Preferences {
  readonly http: HttpPreferences;
  readonly proxy: ProxyPreferences;
  readonly ssl: SslPreferences;
  readonly wsdl: WsdlPreferences;
  readonly wsi: WsiPreferences;
  readonly editor: EditorPreferences;
  readonly ui: UiPreferences;
  readonly updates: UpdatePreferences;
  /**
   * Keybinding overrides, keyed by command id: the chord that runs it, or `''` when the user
   * unbound it. Empty by default — a command with no entry uses its registered chord. Written
   * by the Shortcuts editor and read by the renderer's keybinding dispatcher.
   */
  readonly shortcuts: Readonly<Record<string, string>>;
}

/** The preferences a first run gets. */
export const DEFAULT_PREFERENCES: Preferences = Object.freeze({
  http: Object.freeze({
    version: '1.1',
    userAgent: 'Wirebench/0.1',
    requestCompression: 'none',
    responseCompression: true,
    closeConnections: false,
    chunkingThreshold: 0,
    socketTimeoutMs: 60_000,
    maxConnections: 100,
    allowH2: false,
  }),
  proxy: Object.freeze({ mode: 'none', excludes: Object.freeze([]) }),
  ssl: Object.freeze({ minVersion: 'TLSv1.2', trustAll: false }),
  wsdl: Object.freeze({
    cacheDefinitions: true,
    prettyPrint: true,
    sampleValues: false,
    typeComments: false,
    includeOptional: true,
    strictSchema: false,
    compression: false,
    nameWithBinding: false,
  }),
  wsi: Object.freeze({ verbose: false, profile: 'BP1.1' }),
  editor: Object.freeze({
    fontSize: 13,
    tabSize: 3,
    lineNumbers: true,
    wordWrap: false,
    autoValidateOnSend: false,
    autoFormatResponses: true,
    autosave: false,
  }),
  ui: Object.freeze({
    theme: 'dark',
    defaultLayout: Object.freeze({ orientation: 'side-by-side', mode: 'split' }),
    confirmOnDelete: true,
    historyCap: 1000,
  }),
  updates: Object.freeze({ checkOnLaunch: false }),
  shortcuts: Object.freeze({}),
});

/**
 * The persisted document shape. Deliberately loose: every section and every field is optional
 * and unknown keys are stripped, so a file written by a newer build (or hand-edited badly)
 * still loads — {@link mergePreferences} fills the gaps from {@link DEFAULT_PREFERENCES}.
 */
export const preferencesSchema = z.object({
  version: z.literal(1).optional(),
  http: z
    .object({
      version: z.literal('1.1').optional(),
      userAgent: z.string().optional(),
      requestCompression: z.enum(['none', 'gzip']).optional(),
      responseCompression: z.boolean().optional(),
      closeConnections: z.boolean().optional(),
      chunkingThreshold: z.number().optional(),
      socketTimeoutMs: z.number().optional(),
      maxConnections: z.number().optional(),
      allowH2: z.boolean().optional(),
    })
    .optional(),
  proxy: z
    .object({
      mode: z.enum(['none', 'system', 'manual']).optional(),
      host: z.string().optional(),
      port: z.number().optional(),
      username: z.string().optional(),
      passwordRef: z.string().optional(),
      excludes: z.array(z.string()).optional(),
    })
    .optional(),
  ssl: z
    .object({
      minVersion: z.enum(['TLSv1.2', 'TLSv1.3']).optional(),
      caBundlePath: z.string().optional(),
      caBundlePickedByMain: z.boolean().optional(),
      clientKeystoreRef: z.string().optional(),
    })
    .optional(),
  wsdl: z
    .object({
      cacheDefinitions: z.boolean().optional(),
      prettyPrint: z.boolean().optional(),
      sampleValues: z.boolean().optional(),
      typeComments: z.boolean().optional(),
      includeOptional: z.boolean().optional(),
      strictSchema: z.boolean().optional(),
      compression: z.boolean().optional(),
      nameWithBinding: z.boolean().optional(),
    })
    .optional(),
  wsi: z.object({ verbose: z.boolean().optional(), profile: z.literal('BP1.1').optional() }).optional(),
  editor: z
    .object({
      fontFamily: z.string().optional(),
      fontSize: z.number().optional(),
      tabSize: z.number().optional(),
      lineNumbers: z.boolean().optional(),
      wordWrap: z.boolean().optional(),
      autoValidateOnSend: z.boolean().optional(),
      autoFormatResponses: z.boolean().optional(),
      autosave: z.boolean().optional(),
    })
    .optional(),
  ui: z
    .object({
      theme: z.enum(['dark', 'light', 'system']).optional(),
      defaultLayout: z
        .object({
          orientation: z.enum(['side-by-side', 'stacked']).optional(),
          mode: z.enum(['split', 'tabs']).optional(),
        })
        .optional(),
      confirmOnDelete: z.boolean().optional(),
      historyCap: z.number().optional(),
    })
    .optional(),
  updates: z.object({ checkOnLaunch: z.boolean().optional() }).optional(),
  shortcuts: z.record(z.string(), z.string()).optional(),
});

/** A partial preferences document, as accepted by {@link mergePreferences}. */
export type PreferencesPatch = z.infer<typeof preferencesSchema>;

/** Drops every `undefined` value so a patch never overwrites a default with nothing. */
function defined(value: object | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value ?? {})) {
    if (entry !== undefined) {
      out[key] = entry;
    }
  }
  return out;
}

/**
 * Overlays the defined fields of `patch` onto `base`. The cast is sound because the schema has
 * already validated every value it let through, and TypeScript cannot express "the same keys,
 * each optional but never `undefined`" for a spread under `exactOptionalPropertyTypes`.
 */
function mergeSection<T extends object>(base: T, patch: object | undefined): T {
  return { ...base, ...defined(patch) };
}

/** Parses one top-level section's raw value against its own schema; `undefined` on any failure. */
function parseSection<T>(schema: z.ZodType<T>, raw: unknown): T | undefined {
  const parsed = schema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Deep-merges `patch` onto `base` (default {@link DEFAULT_PREFERENCES}), one level per
 * section. Unknown keys are ignored (the schema strips them), `undefined` values leave the
 * base value alone, and `trustAll` is pinned to `false` regardless of what a file claims.
 *
 * Each top-level section is parsed independently, so a bad field in (say) `wsdl` only loses
 * `wsdl` — every other section of the same patch still applies. Parsing the whole document in
 * one shot would instead discard the entire patch the moment any single field anywhere in it
 * failed to validate, which is worse than doing nothing with the parts that were fine.
 *
 * @param patch a parsed (or raw) partial preferences document
 * @param base the preferences to merge onto; defaults to the built-in defaults
 */
export function mergePreferences(patch: unknown, base: Preferences = DEFAULT_PREFERENCES): Preferences {
  const root: Record<string, unknown> = typeof patch === 'object' && patch !== null ? (patch as never) : {};
  const shape = preferencesSchema.shape;
  const value: PreferencesPatch = {
    http: parseSection(shape.http, root['http']),
    proxy: parseSection(shape.proxy, root['proxy']),
    ssl: parseSection(shape.ssl, root['ssl']),
    wsdl: parseSection(shape.wsdl, root['wsdl']),
    wsi: parseSection(shape.wsi, root['wsi']),
    editor: parseSection(shape.editor, root['editor']),
    ui: parseSection(shape.ui, root['ui']),
    updates: parseSection(shape.updates, root['updates']),
    shortcuts: parseSection(shape.shortcuts, root['shortcuts']),
  };
  return {
    http: mergeSection(base.http, value.http),
    proxy: mergeSection(base.proxy, value.proxy),
    ssl: { ...mergeSection(base.ssl, value.ssl), trustAll: false },
    wsdl: mergeSection(base.wsdl, value.wsdl),
    wsi: mergeSection(base.wsi, value.wsi),
    editor: mergeSection(base.editor, value.editor),
    ui: {
      ...mergeSection(base.ui, value.ui),
      defaultLayout: mergeSection(base.ui.defaultLayout, value.ui?.defaultLayout),
    },
    updates: mergeSection(base.updates, value.updates),
    shortcuts: { ...base.shortcuts, ...(value.shortcuts ?? {}) },
  };
}

/** The section names a "Reset section" action addresses. */
export type PreferencesSection = keyof Preferences;

/** Restores one section (or, with no section, everything) to {@link DEFAULT_PREFERENCES}. */
export function resetPreferences(current: Preferences, section?: PreferencesSection): Preferences {
  if (section === undefined) {
    return DEFAULT_PREFERENCES;
  }
  return { ...current, [section]: DEFAULT_PREFERENCES[section] };
}
