/**
 * `@wirebench/engine/plugin`: what a plugin author builds against (phase 7 spec §5, ADR-0031).
 *
 * Self-contained on purpose: this file imports nothing, so the surface a plugin relies on is exactly
 * what is written here, and the engine's own types stay free to change behind a mapping. Its version,
 * {@link PLUGIN_API_VERSION}, is its own; `pnpm check:plugin-api` compares the emitted declarations
 * with the committed report `api/plugin.api.d.ts` and fails on a change that did not bump it.
 *
 * A plugin is one folder: a `wirebench-plugin.json` manifest ({@link PluginManifest}) and one bundled
 * ES module that imports nothing and exports a {@link PluginModule}. It runs in the script sandbox:
 * no files, no environment, no timers, no secrets, and network only for an importer that lists
 * origins.
 */

/**
 * The plugin API's version, semver. A manifest names the major it was written for (`"api": 1`); a
 * minor adds, a major breaks.
 */
export const PLUGIN_API_VERSION = '1.0.0';

// ─── The manifest ────────────────────────────────────────────────────────────────────────────────

/** `wirebench-plugin.json`. Every contribution and capability a plugin has is declared here. */
export interface PluginManifest {
  readonly manifestVersion: 1;
  /** `^[a-z0-9][a-z0-9-]{1,62}$`; the folder name and the prefix of every contribution id. */
  readonly id: string;
  readonly name: string;
  /** The plugin's own version, semver. */
  readonly version: string;
  /** The plugin API major it was written for. */
  readonly api: 1;
  /** The bundled module, relative to the manifest: `main.js`. */
  readonly main: string;
  readonly description?: string;
  readonly contributes: PluginContributes;
  readonly capabilities?: PluginCapabilities;
}

/** What a plugin adds. Each id is unique within its point and is used as `<plugin-id>/<id>`. */
export interface PluginContributes {
  readonly importers?: readonly ImporterDeclaration[];
  readonly reporters?: readonly ReporterDeclaration[];
  readonly codeGenerators?: readonly CodeGeneratorDeclaration[];
}

export interface ImporterDeclaration {
  readonly id: string;
  readonly title: string;
  /** File extensions with their dot, for a host's file picker: `[".acme"]`. */
  readonly extensions?: readonly string[];
}

export interface ReporterDeclaration {
  readonly id: string;
  readonly title: string;
  /** The extension a report usually takes, with its dot: `".txt"`. */
  readonly extension: string;
}

export interface CodeGeneratorDeclaration {
  readonly id: string;
  readonly title: string;
  /** An editor language id, used only to highlight the output: `"kotlin"`. */
  readonly language: string;
}

export interface PluginCapabilities {
  /**
   * The origins an importer may fetch from, exactly: `["https://schemas.example.com"]`. No paths, no
   * wildcards. Refused on a plugin with no importer.
   */
  readonly network?: readonly string[];
}

// ─── The module ──────────────────────────────────────────────────────────────────────────────────

/** What the plugin's module exports: one object per point, keyed by the manifest's contribution ids. */
export interface PluginModule {
  readonly importers?: Readonly<Record<string, Importer>>;
  readonly reporters?: Readonly<Record<string, Reporter>>;
  readonly codeGenerators?: Readonly<Record<string, CodeGenerator>>;
}

/** What every call is given besides its input. */
export interface PluginContext {
  /** One line to the host's log, prefixed with the plugin's id. */
  log(message: string): void;
}

// ─── Importers ───────────────────────────────────────────────────────────────────────────────────

export interface Importer {
  /**
   * Whether `input` is this format. Shown at most the first 1 MiB, and only when no built-in format
   * claims the file. Return `null` when it is not.
   */
  detect(input: ImportInput): 'definite' | 'probable' | null;
  import(input: ImportInput, context: ImportContext): ImportResult | Promise<ImportResult>;
}

/** The file being imported. */
export interface ImportInput {
  readonly filename: string;
  readonly text: string;
}

export interface ImportContext extends PluginContext {
  /** Present only when the manifest lists origins. */
  readonly net?: PluginNet;
}

/** The brokered network: through the host's proxy and TLS settings, recorded and redacted. */
export interface PluginNet {
  /** @throws for an origin the manifest does not list, or a private address */
  fetch(request: NetRequest): Promise<NetResponse>;
}

export interface NetRequest {
  /** Default `GET`. */
  readonly method?: string;
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
}

export interface NetResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

/**
 * What an importer returns: REST APIs, plain variables and environments. The host checks it and
 * places it as it places a built-in import. A secret variable is reported, never written.
 */
export interface ImportResult {
  readonly apis: readonly ImportedApi[];
  /** Project properties. */
  readonly variables?: readonly ImportedVariable[];
  readonly environments?: readonly ImportedEnvironment[];
  /** Shown to the person after the import. */
  readonly report?: { readonly warnings?: readonly string[]; readonly notes?: readonly string[] };
}

export interface ImportedApi {
  readonly name: string;
  readonly description?: string;
  readonly items: readonly ImportedItem[];
}

export type ImportedItem = ImportedFolder | ImportedRequest;

export interface ImportedFolder {
  readonly kind: 'folder';
  readonly name: string;
  readonly items: readonly ImportedItem[];
}

export interface ImportedRequest {
  readonly kind: 'request';
  readonly name: string;
  readonly method: string;
  /** `http:` or `https:`; may hold `${name}` references to variables. */
  readonly url: string;
  readonly headers?: readonly NameValue[];
  readonly body?: ImportedBody;
  readonly description?: string;
}

export type ImportedBody =
  | { readonly kind: 'raw'; readonly text: string; readonly contentType?: string }
  | { readonly kind: 'form'; readonly fields: readonly NameValue[] };

export interface NameValue {
  readonly name: string;
  readonly value: string;
}

export interface ImportedVariable extends NameValue {
  /** A secret is reported to the person and not written. */
  readonly secret?: boolean;
}

export interface ImportedEnvironment {
  readonly name: string;
  readonly variables: readonly ImportedVariable[];
}

// ─── Reporters ───────────────────────────────────────────────────────────────────────────────────

export interface Reporter {
  /** The report file's text. The host writes it; it never opens or serves it. */
  render(report: RunReport, context: PluginContext): string;
}

/**
 * A finished run, masked. Exchanges (the raw request and response text) are not included: a
 * reporter gets outcomes, not traffic.
 */
export interface RunReport {
  readonly formatVersion: 1;
  readonly tool: { readonly name: string; readonly version: string };
  /** ISO 8601. */
  readonly startedAt: string;
  readonly environment?: string;
  readonly summary: RunReportSummary;
  readonly requests: readonly RunReportRequest[];
}

export interface RunReportSummary {
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly errored: number;
  readonly skipped: number;
  readonly durationMs: number;
}

export interface RunReportRequest {
  readonly path: string;
  readonly group: string;
  readonly name: string;
  /** `soap`, `rest`, `grpc`, `websocket`, `mcp` for the built-in protocols. */
  readonly protocol: string;
  readonly outcome: 'passed' | 'failed' | 'errored' | 'skipped';
  readonly status?: number;
  readonly durationMs?: number;
  readonly unasserted: boolean;
  readonly assertions: readonly RunReportAssertion[];
  readonly error?: { readonly code: string; readonly message: string };
  readonly sequence?: { readonly id: string; readonly name: string; readonly stepId: string };
  readonly iteration?: { readonly index: number; readonly count: number; readonly row?: number };
}

export interface RunReportAssertion {
  readonly type: string;
  readonly label: string;
  readonly outcome: 'passed' | 'failed' | 'errored';
  readonly expected?: string;
  readonly actual?: string;
  readonly message?: string;
}

// ─── Code generators ─────────────────────────────────────────────────────────────────────────────

export interface CodeGenerator {
  generate(request: CodeRequest, layout: Layout, context: PluginContext): GeneratedCode;
}

/**
 * A value that may read the environment: literal text and environment reads, in order. A
 * credential always arrives as an environment read, never as text.
 */
export type Text = readonly TextPart[];

export type TextPart = { readonly text: string } | { readonly env: string };

/** One resolved request, as every built-in language sees it. */
export interface CodeRequest {
  readonly method: string;
  readonly url: Text;
  readonly headers: readonly { readonly name: string; readonly value: Text }[];
  readonly body: CodeBody;
  /** Basic credentials the transport applies. */
  readonly basic?: { readonly username: Text; readonly password: Text };
  /** Send even when the certificate does not verify. */
  readonly insecure?: boolean;
  readonly followRedirects: boolean;
  readonly maxRedirects?: number;
  readonly timeoutMs?: number;
}

export type CodeBody =
  | { readonly kind: 'none' }
  | { readonly kind: 'raw'; readonly text: Text }
  | { readonly kind: 'form'; readonly fields: readonly { readonly name: string; readonly value: Text }[] }
  | { readonly kind: 'multipart'; readonly parts: readonly CodePart[] }
  | { readonly kind: 'binary'; readonly path: string };

export type CodePart =
  | { readonly kind: 'text'; readonly name: string; readonly value: Text; readonly contentType?: string }
  | { readonly kind: 'file'; readonly name: string; readonly path: string; readonly contentType?: string };

/** How the snippet is laid out. */
export interface Layout {
  /** One level of indentation. */
  readonly unit: string;
  readonly followRedirects: boolean;
  /** Only when following. */
  readonly maxRedirects?: number;
  /** Absent: no timeout. */
  readonly timeoutMs?: number;
}

export interface GeneratedCode {
  readonly code: string;
  /** One line each, shown under the snippet. */
  readonly notes: readonly string[];
}
