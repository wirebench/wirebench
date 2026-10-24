/**
 * The application's global preferences: the settings that live with the *user*, not with a
 * project, and are persisted by the desktop app in `userData/preferences.yaml`.
 *
 * Everything here is deliberately plain data — the engine never reads a file for it. The
 * desktop's `PreferencesService` loads/merges/persists a document; the engine consumes the
 * merged object (see `soap/send-input.ts`).
 *
 * Some sections are persisted and shown before they are wired to behaviour: `proxy` and `ssl`
 * become effective with the connection settings task.
 * They are modelled now so a preferences file written today survives those tasks unchanged.
 */

import { z } from 'zod';
import { defaultUserAgent, isDefaultUserAgent } from '../http/default-headers.js';

/** HTTP transport preferences applied to every send. */
export interface HttpPreferences {
  /** Reserved: only HTTP/1.1 is implemented. */
  readonly version: '1.1';
  /**
   * `User-Agent` added to a request that does not set one itself. A default one (`Wirebench`, or
   * `Wirebench/<version>`) follows the running app's version: see {@link withAppUserAgent}.
   */
  readonly userAgent: string;
  /** `gzip` compresses the request body and sets `Content-Encoding: gzip`. */
  readonly requestCompression: 'none' | 'gzip';
  /**
   * Advertise `Accept-Encoding` so servers may compress the response: `REST_ACCEPT_ENCODING` on a
   * REST request, `SOAP_ACCEPT_ENCODING` on a SOAP one.
   */
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
   * Offer HTTP/2 in the TLS ALPN handshake (ADR-0024). On by default: the server picks, so a
   * stack that speaks HTTP/1.1 only stays on it. Off pins every send to HTTP/1.1, for a server
   * that asks for a client certificate mid-connection (renegotiation, which HTTP/2 forbids).
   * NTLM and Kerberos always use HTTP/1.1. Replaces `allowH2`, which every saved file carried
   * as `false` although it never turned HTTP/2 off for a direct send; that key is dropped.
   */
  readonly offerH2: boolean;
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
   * How many days before a certificate expires the workspace's certificate check starts warning
   * about it: endpoint chains, keystores and the CA bundle alike. `0` warns only once expired.
   */
  readonly expiryWarningDays: number;
  /**
   * Always `false`: trusting every certificate globally is not an option Wirebench offers.
   * The only escape hatch is an endpoint's `trustInvalid`, which is badged in red wherever
   * that endpoint appears.
   */
  readonly trustAll: false;
}

/** Git executable preferences, main-only, never settable through `preferences.update`. */
export interface GitPreferences {
  /** Absolute path to the `git` executable the desktop uses; read/written in main only. */
  readonly path?: string;
  /**
   * Set by the desktop main process when, and only when, {@link path} came from a native file
   * picker it ran itself (`git.locate`). Mirrors `SslPreferences.caBundlePickedByMain`: a
   * hand-edited `preferences.yaml` gets no trust from this field until the path is picked
   * again. Never settable through `preferences.update`.
   */
  readonly pathPickedByMain?: boolean;
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

/**
 * REST client preferences: the defaults every REST request inherits, and the two viewer limits.
 *
 * Redirects are followed by default here and not for SOAP, deliberately: a REST API that answers a
 * `GET` with a 301 to its canonical URL is ordinary, while a redirected SOAP `POST` is a sign
 * something is wrong (see the roadmap's note on the same-host upgrade case).
 */
export interface RestPreferences {
  readonly followRedirects: boolean;
  readonly maxRedirects: number;
  /** Above this many bytes the response viewer stops offering the formatted view. */
  readonly prettyPrintMaxBytes: number;
  /** `Accept` added to a request that does not set one. Empty by default: say nothing, take anything. */
  readonly defaultAccept: string;
  /**
   * Fixed loopback port for the OAuth2 authorization-code callback, for providers that demand an
   * exact redirect URI. Absent means a random free port, which is what RFC 8252 §7.3 prefers.
   */
  readonly oauth2CallbackPort?: number;
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
  /**
   * Whether a single click in the Explorer opens a preview tab, shown in italics, that the next single click
   * replaces (#679). Off: every click opens a tab of its own.
   */
  readonly previewTabs: boolean;
  /** How many history entries are kept per project. */
  readonly historyCap: number;
  /** How many rows the HTTP Log keeps in memory ({@link LOG_SIZE_MIN}–{@link LOG_SIZE_MAX}). */
  readonly logSize: number;
}

/** The smallest HTTP Log row limit a user can set. */
export const LOG_SIZE_MIN = 100;
/** The largest HTTP Log row limit a user can set. */
export const LOG_SIZE_MAX = 5000;

/**
 * Software-update preferences. `checkOnLaunch` is off by default and stays off until the user
 * turns it on: Wirebench contacts the release feed when asked, not when started.
 */
export interface UpdatePreferences {
  /** Check GitHub Releases for a newer version once, shortly after the app starts. */
  readonly checkOnLaunch: boolean;
  /**
   * Which releases a check offers: `stable` only, or `preview` (pre-releases such as `6.2.0-rc.1`)
   * as well. Going back to `stable` never offers a downgrade: a preview build waits for the next
   * stable release that is newer than it.
   */
  readonly channel: UpdateChannel;
}

/** The update channels: {@link UpdatePreferences.channel}. */
export type UpdateChannel = 'stable' | 'preview';

/** Account-related preferences. The account list itself lives elsewhere; this is display-only. */
export interface AccountPreferences {
  /** Whether the status bar shows the account item once a server is known. */
  readonly showInStatusBar: boolean;
}

/** Secret sources (secret sources spec D6). */
export interface SecretsPreferences {
  /** How long a value fetched from a secret manager stays in memory, in seconds; 0 fetches it on every send. */
  readonly sourceCacheSeconds: number;
  /** The app lock (#428): ask for biometrics or the OS password before SSH secrets are used. */
  readonly appLock: boolean;
  /** Minutes without input on the machine after which the app lock asks again. */
  readonly appLockIdleMinutes: number;
}

/** Mock services (#59). */
export interface MockPreferences {
  /**
   * Bind a started mock to every interface (`0.0.0.0`) rather than loopback. Off by default: a mock
   * answers whatever reaches its port, and a project file can never turn this on.
   */
  readonly listenOnAllInterfaces: boolean;
}

/** The SSH terminal (SSH area spec D6). */
export interface TerminalPreferences {
  /** Ask before a multi-line paste goes to the shell, because a pasted script runs line by line. */
  readonly confirmMultilinePaste: boolean;
  /** Ask before closing a tab that holds a live session: closing it ends the connection (S53). */
  readonly confirmCloseSessions: boolean;
  /** Copy the selection to the clipboard as soon as it is made. */
  readonly copyOnSelect: boolean;
  /** Reconnect, with backoff, a session the network dropped (never one that exited or failed to sign in). */
  readonly autoReconnect: boolean;
  /** How many reconnect attempts a dropped session gets before the tab gives up. */
  readonly reconnectAttempts: number;
  /** Offer the rest of a snippet, dimmed after the cursor, when the typed line is its start; Tab accepts. */
  readonly snippetSuggestions: boolean;
  /** Colour error and warning words and IP addresses in the output, as decorations over the plain text. */
  readonly highlightOutput: boolean;
  /** An installed font family, tried before the app's monospace stack; unset or empty uses the stack alone. */
  readonly fontFamily?: string;
  readonly fontSize: number;
  /** A multiple of the font size. */
  readonly lineHeight: number;
  /** A built-in scheme id, or `app` to follow the app theme; a host or group in `hosts.yaml` may override it. */
  readonly colorScheme: string;
  /** Megabytes all session logs on this machine may take together; past it the oldest logs are deleted. */
  readonly sessionLogMaxMb: number;
  /** Keep each session log's raw stream (escape sequences included) beside its plain text. */
  readonly sessionLogRaw: boolean;
  /** The program a local terminal tab runs (#410); empty for the OS default ($SHELL, or PowerShell on Windows). */
  readonly localShell: string;
}

/**
 * SSH connection defaults (#571): the last level a host's settings resolve to, after the host, its groups and
 * their identities. Per machine, like the rest of this document; the CLI does not read it.
 */
export interface SshPreferences {
  /** The user a host connects as when nothing nearer names one; unset or empty means none. */
  readonly user?: string;
  /** Seconds between keep-alive messages; 0 sends none. */
  readonly keepAlive: number;
  /** Seconds to wait for a server to answer before giving up. */
  readonly connectTimeout: number;
  /** The character set a host's terminal reads and writes (#427); an id the SSH package does not know is passed over. */
  readonly charset: string;
  /** The terminal type a host's pty request names (#427). */
  readonly term: string;
}

/** The whole preferences document. */
export interface Preferences {
  readonly http: HttpPreferences;
  readonly proxy: ProxyPreferences;
  readonly ssl: SslPreferences;
  readonly git: GitPreferences;
  readonly wsdl: WsdlPreferences;
  readonly wsi: WsiPreferences;
  readonly rest: RestPreferences;
  readonly editor: EditorPreferences;
  readonly ui: UiPreferences;
  readonly updates: UpdatePreferences;
  readonly accounts: AccountPreferences;
  readonly secrets: SecretsPreferences;
  readonly mocks: MockPreferences;
  readonly terminal: TerminalPreferences;
  readonly ssh: SshPreferences;
  /**
   * Feature switches by id (`grpc`, `scripts`, …), phase 4 spec §4.1: true turns a feature on,
   * false off; an id with no entry keeps its descriptor's default. The machine's level of the
   * three (team policy, this, the default); a team policy can only restrict it (ADR-0029). Applied
   * at the next start.
   */
  readonly features: Readonly<Record<string, boolean>>;
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
    userAgent: defaultUserAgent(),
    requestCompression: 'none',
    responseCompression: true,
    closeConnections: false,
    chunkingThreshold: 0,
    socketTimeoutMs: 60_000,
    maxConnections: 100,
    offerH2: true,
  }),
  proxy: Object.freeze({ mode: 'none', excludes: Object.freeze([]) }),
  ssl: Object.freeze({ minVersion: 'TLSv1.2', expiryWarningDays: 30, trustAll: false }),
  git: Object.freeze({}),
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
  rest: Object.freeze({
    followRedirects: true,
    maxRedirects: 5,
    prettyPrintMaxBytes: 5 * 1024 * 1024,
    defaultAccept: '',
  }),
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
    previewTabs: true,
    historyCap: 1000,
    logSize: 500,
  }),
  updates: Object.freeze({ checkOnLaunch: false, channel: 'stable' }),
  accounts: Object.freeze({ showInStatusBar: true }),
  secrets: Object.freeze({ sourceCacheSeconds: 300, appLock: false, appLockIdleMinutes: 15 }),
  mocks: Object.freeze({ listenOnAllInterfaces: false }),
  terminal: Object.freeze({
    confirmMultilinePaste: true,
    confirmCloseSessions: true,
    copyOnSelect: false,
    autoReconnect: true,
    reconnectAttempts: 10,
    snippetSuggestions: true,
    highlightOutput: true,
    fontSize: 13,
    lineHeight: 1,
    colorScheme: 'app',
    sessionLogMaxMb: 500,
    sessionLogRaw: false,
    localShell: '',
  }),
  ssh: Object.freeze({ keepAlive: 15, connectTimeout: 20, charset: 'utf-8', term: 'xterm-256color' }),
  features: Object.freeze({}),
  shortcuts: Object.freeze({}),
});

/** The range a numeric preference accepts. `max` absent means no upper bound beyond a safe integer. */
export interface PreferenceNumberLimit {
  readonly min: number;
  readonly max?: number;
  /** Whole numbers only. */
  readonly integer: boolean;
}

/**
 * Every numeric preference's accepted range, keyed by dotted preference key.
 *
 * One table serves three readers: {@link preferencesSchema} refuses anything outside it (so
 * `preferences.update` rejects an out-of-range patch rather than storing it), {@link mergePreferences}
 * clamps a finite out-of-range number *read from disk* into it (so a file written before these
 * limits existed loads instead of losing its whole section), and the desktop renderer restates it
 * to validate a field as it is typed.
 */
export const PREFERENCE_NUMBER_LIMITS = {
  'http.chunkingThreshold': { min: 0, integer: true },
  'http.socketTimeoutMs': { min: 0, max: 3_600_000, integer: true },
  'http.maxConnections': { min: 1, max: 1000, integer: true },
  'proxy.port': { min: 1, max: 65_535, integer: true },
  'ssl.expiryWarningDays': { min: 0, max: 3650, integer: true },
  'rest.maxRedirects': { min: 0, max: 50, integer: true },
  /** Bytes; the Settings page edits it in MiB (0.01–1024). */
  'rest.prettyPrintMaxBytes': { min: 1, max: 1024 * 1024 * 1024, integer: true },
  'rest.oauth2CallbackPort': { min: 1024, max: 65_535, integer: true },
  'editor.fontSize': { min: 6, max: 72, integer: true },
  'editor.tabSize': { min: 1, max: 16, integer: true },
  'ui.historyCap': { min: 1, max: 100_000, integer: true },
  'ui.logSize': { min: LOG_SIZE_MIN, max: LOG_SIZE_MAX, integer: true },
  'secrets.sourceCacheSeconds': { min: 0, max: 3600, integer: true },
  'secrets.appLockIdleMinutes': { min: 1, max: 240, integer: true },
  'terminal.reconnectAttempts': { min: 1, max: 100, integer: true },
  'terminal.fontSize': { min: 6, max: 72, integer: true },
  'terminal.lineHeight': { min: 1, max: 2, integer: false },
  /** Megabytes. */
  'terminal.sessionLogMaxMb': { min: 10, max: 100_000, integer: true },
  /** Seconds. */
  'ssh.keepAlive': { min: 0, max: 3600, integer: true },
  /** Seconds. */
  'ssh.connectTimeout': { min: 1, max: 600, integer: true },
} as const satisfies Readonly<Record<string, PreferenceNumberLimit>>;

/** A dotted key with an entry in {@link PREFERENCE_NUMBER_LIMITS}. */
export type LimitedPreferenceKey = keyof typeof PREFERENCE_NUMBER_LIMITS;

function limitOf(key: string): PreferenceNumberLimit | undefined {
  return Object.hasOwn(PREFERENCE_NUMBER_LIMITS, key)
    ? (PREFERENCE_NUMBER_LIMITS as Record<string, PreferenceNumberLimit>)[key]
    : undefined;
}

/** "a whole number from 1 to 65535", "a number of 0 or more" — the rule, in words. */
export function describePreferenceLimit(limit: PreferenceNumberLimit): string {
  const kind = limit.integer ? 'a whole number' : 'a number';
  return limit.max === undefined ? `${kind} of ${limit.min} or more` : `${kind} from ${limit.min} to ${limit.max}`;
}

/** The schema for one limited numeric field; the message names the rule, not zod's wording. */
function limited(key: LimitedPreferenceKey) {
  const limit: PreferenceNumberLimit = PREFERENCE_NUMBER_LIMITS[key];
  const message = `${key} must be ${describePreferenceLimit(limit)}`;
  let schema = z.number(message).finite(message).min(limit.min, message);
  if (limit.max !== undefined) {
    schema = schema.max(limit.max, message);
  }
  return limit.integer ? schema.int(message) : schema;
}

/**
 * Pulls a finite number read from disk into its limit: rounded when the field is whole-number,
 * then clamped. Anything that is not a finite number is left for the schema to refuse.
 */
function clampToLimit(limit: PreferenceNumberLimit, value: unknown): unknown {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return value;
  }
  const rounded = limit.integer ? Math.round(value) : value;
  const floored = Math.max(limit.min, rounded);
  return Math.min(limit.max ?? Number.MAX_SAFE_INTEGER, floored);
}

/** {@link clampToLimit} over every limited field of one raw section. */
function clampSection(section: string, raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return raw;
  }
  const out: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
  for (const [key, value] of Object.entries(out)) {
    const limit = limitOf(`${section}.${key}`);
    if (limit !== undefined) {
      out[key] = clampToLimit(limit, value);
    }
  }
  return out;
}

/**
 * The persisted document shape. Deliberately loose in shape: every section and every field is
 * optional and unknown keys are stripped, so a file written by a newer build (or hand-edited
 * badly) still loads — {@link mergePreferences} fills the gaps from {@link DEFAULT_PREFERENCES}.
 * Strict in range: a numeric field outside {@link PREFERENCE_NUMBER_LIMITS} does not parse, which
 * is what lets {@link preferencesPatchProblems} refuse it; `mergePreferences` clamps such a value
 * before parsing, so an old file is pulled into range rather than losing the section.
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
      chunkingThreshold: limited('http.chunkingThreshold').optional(),
      socketTimeoutMs: limited('http.socketTimeoutMs').optional(),
      maxConnections: limited('http.maxConnections').optional(),
      offerH2: z.boolean().optional(),
    })
    .optional(),
  proxy: z
    .object({
      mode: z.enum(['none', 'system', 'manual']).optional(),
      host: z.string().optional(),
      // `null` in a patch clears the port (an emptied field); it is never stored.
      port: limited('proxy.port').nullable().optional(),
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
      expiryWarningDays: limited('ssl.expiryWarningDays').optional(),
    })
    .optional(),
  git: z.object({ path: z.string().optional(), pathPickedByMain: z.boolean().optional() }).optional(),
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
  rest: z
    .object({
      followRedirects: z.boolean().optional(),
      maxRedirects: limited('rest.maxRedirects').optional(),
      prettyPrintMaxBytes: limited('rest.prettyPrintMaxBytes').optional(),
      defaultAccept: z.string().optional(),
      // `null` in a patch clears the pinned port (back to a free one per sign-in); never stored.
      oauth2CallbackPort: limited('rest.oauth2CallbackPort').nullable().optional(),
    })
    .optional(),
  editor: z
    .object({
      fontFamily: z.string().optional(),
      fontSize: limited('editor.fontSize').optional(),
      tabSize: limited('editor.tabSize').optional(),
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
      previewTabs: z.boolean().optional(),
      historyCap: limited('ui.historyCap').optional(),
      logSize: limited('ui.logSize').optional(),
    })
    .optional(),
  updates: z
    .object({ checkOnLaunch: z.boolean().optional(), channel: z.enum(['stable', 'preview']).optional() })
    .optional(),
  accounts: z.object({ showInStatusBar: z.boolean().optional() }).optional(),
  secrets: z
    .object({
      sourceCacheSeconds: limited('secrets.sourceCacheSeconds').optional(),
      appLock: z.boolean().optional(),
      appLockIdleMinutes: limited('secrets.appLockIdleMinutes').optional(),
    })
    .optional(),
  mocks: z.object({ listenOnAllInterfaces: z.boolean().optional() }).optional(),
  terminal: z
    .object({
      confirmMultilinePaste: z.boolean().optional(),
      confirmCloseSessions: z.boolean().optional(),
      copyOnSelect: z.boolean().optional(),
      autoReconnect: z.boolean().optional(),
      reconnectAttempts: limited('terminal.reconnectAttempts').optional(),
      snippetSuggestions: z.boolean().optional(),
      highlightOutput: z.boolean().optional(),
      fontFamily: z.string().optional(),
      fontSize: limited('terminal.fontSize').optional(),
      lineHeight: limited('terminal.lineHeight').optional(),
      colorScheme: z
        .string()
        .regex(/^[a-z0-9][a-z0-9-]*$/)
        .optional(),
      sessionLogMaxMb: limited('terminal.sessionLogMaxMb').optional(),
      sessionLogRaw: z.boolean().optional(),
      localShell: z.string().optional(),
    })
    .optional(),
  ssh: z
    .object({
      user: z.string().optional(),
      keepAlive: limited('ssh.keepAlive').optional(),
      connectTimeout: limited('ssh.connectTimeout').optional(),
      charset: z
        .string()
        .regex(/^[a-z0-9][a-z0-9-]*$/)
        .optional(),
      term: z
        .string()
        .regex(/^[A-Za-z0-9][A-Za-z0-9.+_-]{0,63}$/)
        .optional(),
    })
    .optional(),
  /** A `null` value removes the switch, so a row can go back to its descriptor's default. */
  features: z.record(z.string().regex(/^[a-z][a-z0-9-]{0,31}$/), z.boolean().nullable()).optional(),
  shortcuts: z.record(z.string(), z.string()).optional(),
});

/** A partial preferences document, as accepted by {@link mergePreferences}. */
export type PreferencesPatch = z.infer<typeof preferencesSchema>;

/**
 * Overlays the defined fields of `patch` onto `base`. An `undefined` value leaves the base value
 * alone, so a patch never overwrites a default with nothing; a `null` value (allowed only where
 * the schema says so — an optional port the user emptied) removes the key. The cast is sound
 * because the schema has already validated every value it let through, and TypeScript cannot
 * express "the same keys, each optional but never `undefined`" for a spread under
 * `exactOptionalPropertyTypes`.
 */
function mergeSection<T extends object>(base: T, patch: object | undefined): T {
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, entry] of Object.entries(patch ?? {})) {
    if (entry === null) {
      delete out[key];
    } else if (entry !== undefined) {
      out[key] = entry;
    }
  }
  return out as T;
}

/**
 * Parses one top-level section's raw value against its own schema; `undefined` on any failure.
 * Limited numeric fields are clamped first, so only a value of the wrong *type* loses the section.
 */
function parseSection<T>(name: string, schema: z.ZodType<T>, raw: unknown): T | undefined {
  const parsed = schema.safeParse(clampSection(name, raw));
  return parsed.success ? parsed.data : undefined;
}

/**
 * Checks a patch strictly, the way `preferences.update` must: every problem in every known
 * section, worded for a person ("proxy.port must be a whole number from 1 to 65535"). Unknown
 * sections and keys are not problems — they are ignored, as {@link mergePreferences} ignores them.
 * Nothing is clamped here: a value typed by the user that is out of range is refused, not changed.
 *
 * @returns an empty array when the patch is acceptable
 */
export function preferencesPatchProblems(patch: unknown): string[] {
  if (typeof patch !== 'object' || patch === null) {
    return [];
  }
  const shape: Record<string, z.ZodType> = preferencesSchema.shape;
  const problems: string[] = [];
  for (const [section, raw] of Object.entries(patch)) {
    const schema = Object.hasOwn(shape, section) ? shape[section] : undefined;
    if (schema === undefined || raw === undefined) {
      continue;
    }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const path = [section, ...issue.path.map(String)].join('.');
        problems.push(issue.message.startsWith(path) ? issue.message : `${path}: ${issue.message}`);
      }
    }
  }
  return problems;
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
 * A finite number outside its {@link PREFERENCE_NUMBER_LIMITS} entry is clamped into range (and
 * rounded, for a whole-number field) rather than failing its section: a preferences file written
 * before a limit was tightened — a font size of 100, a fractional port — still loads, with that
 * one value pulled to the nearest acceptable one. `preferences.update` never relies on this; it
 * refuses an out-of-range patch with {@link preferencesPatchProblems} first.
 *
 * @param patch a parsed (or raw) partial preferences document
 * @param base the preferences to merge onto; defaults to the built-in defaults
 */
export function mergePreferences(patch: unknown, base: Preferences = DEFAULT_PREFERENCES): Preferences {
  const root: Record<string, unknown> = typeof patch === 'object' && patch !== null ? (patch as never) : {};
  const shape = preferencesSchema.shape;
  const value: PreferencesPatch = {
    http: parseSection('http', shape.http, root['http']),
    proxy: parseSection('proxy', shape.proxy, root['proxy']),
    ssl: parseSection('ssl', shape.ssl, root['ssl']),
    git: parseSection('git', shape.git, root['git']),
    wsdl: parseSection('wsdl', shape.wsdl, root['wsdl']),
    wsi: parseSection('wsi', shape.wsi, root['wsi']),
    rest: parseSection('rest', shape.rest, root['rest']),
    editor: parseSection('editor', shape.editor, root['editor']),
    ui: parseSection('ui', shape.ui, root['ui']),
    updates: parseSection('updates', shape.updates, root['updates']),
    accounts: parseSection('accounts', shape.accounts, root['accounts']),
    secrets: parseSection('secrets', shape.secrets, root['secrets']),
    mocks: parseSection('mocks', shape.mocks, root['mocks']),
    terminal: parseSection('terminal', shape.terminal, root['terminal']),
    ssh: parseSection('ssh', shape.ssh, root['ssh']),
    features: parseSection('features', shape.features, root['features']),
    shortcuts: parseSection('shortcuts', shape.shortcuts, root['shortcuts']),
  };
  return {
    http: mergeSection(base.http, value.http),
    proxy: mergeSection(base.proxy, value.proxy),
    ssl: { ...mergeSection(base.ssl, value.ssl), trustAll: false },
    git: mergeSection(base.git, value.git),
    wsdl: mergeSection(base.wsdl, value.wsdl),
    wsi: mergeSection(base.wsi, value.wsi),
    rest: mergeSection(base.rest, value.rest),
    editor: mergeSection(base.editor, value.editor),
    ui: {
      ...mergeSection(base.ui, value.ui),
      defaultLayout: mergeSection(base.ui.defaultLayout, value.ui?.defaultLayout),
    },
    updates: mergeSection(base.updates, value.updates),
    accounts: mergeSection(base.accounts, value.accounts),
    secrets: mergeSection(base.secrets, value.secrets),
    mocks: mergeSection(base.mocks, value.mocks),
    terminal: mergeSection(base.terminal, value.terminal),
    ssh: mergeSection(base.ssh, value.ssh),
    // `mergeSection` drops a `null` entry, so the merged record holds booleans only.
    features: mergeSection(base.features, value.features),
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

/**
 * `preferences` with a default `User-Agent` moved to `version`'s, so it names the release that
 * sends it. One the user wrote, or cleared to send none, is theirs and stays. The preferences file
 * holds the whole document, so without this every saved file would keep sending whichever version
 * wrote it first.
 */
export function withAppUserAgent(preferences: Preferences, version: string): Preferences {
  const userAgent = defaultUserAgent(version);
  if (!isDefaultUserAgent(preferences.http.userAgent) || preferences.http.userAgent === userAgent) {
    return preferences;
  }
  return { ...preferences, http: { ...preferences.http, userAgent } };
}
