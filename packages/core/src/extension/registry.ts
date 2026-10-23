/**
 * The three extension points (phase 7 spec §3, §4): importers, reporters and code generators, in one
 * registry built once with a host's feature set. The built-ins register here as in-process entries;
 * a user-installed plugin adds sandboxed ones beside them (slice 3).
 */
import { WirebenchError } from '../errors.js';
import type { CodeOptions, CodeRequest, GeneratedCode } from '../http/codegen/index.js';
import { featureDisabled } from '../protocol/registry.js';
import type { FeatureSet } from '../protocol/features.js';
import type { RunResult } from '../run/run.js';
import type { PluginImportData } from './plugin/results.js';

/** Where a contribution comes from: Wirebench itself, or a plugin the user installed. */
export type ContributionOrigin = { readonly kind: 'builtin' } | { readonly kind: 'plugin'; readonly plugin: string };

/** What every contribution carries. */
export interface ContributionBase {
  /** A built-in's plain id (`junit`), or a plugin's `<plugin-id>/<contribution-id>`. */
  readonly id: string;
  readonly title: string;
  readonly origin: ContributionOrigin;
  /** The feature that switches it; absent when nothing does (an environment import). */
  readonly feature?: string;
}

/** What a detector is shown: the file's name and its text. */
export interface ImportDetectSource {
  readonly filename?: string;
  readonly text: string;
}

/** How sure a detector is that a source is its format. */
export type ImportConfidence = 'definite' | 'probable';

/**
 * An import format. A built-in's detection and placement stay where they are (`import-detect.ts`
 * and each host's import code); a plugin's entry brings its own `detect` and `import`, both of
 * which run in the plugin sandbox.
 */
export interface ImporterContribution extends ContributionBase {
  /** The file extensions the format is read from, for a host's file picker. */
  readonly extensions?: readonly string[];
  detect?(source: ImportDetectSource): Promise<ImportConfidence | null>;
  /** @throws WirebenchError `plugin-error` */
  import?(source: ImportDetectSource): Promise<PluginImportData>;
}

/** What a reporter is told about the tool that ran: the JSON report's `tool` field. */
export interface ReportTool {
  readonly name: string;
  readonly version: string;
}

/** A report format: one masked run result in, one file's text out. */
export interface ReporterContribution extends ContributionBase {
  /** The file extension a report usually takes, with its dot. */
  readonly extension: string;
  /** @throws WirebenchError `plugin-error` for a plugin's reporter */
  render(result: RunResult, tool: ReportTool): string | Promise<string>;
}

/** A code generator: one resolved request in, one snippet out. */
export interface CodeGeneratorContribution extends ContributionBase {
  /** An editor language id, used only to highlight the output. */
  readonly language: string;
  /** The indent the language uses when the user chose none. */
  readonly indent: number | 'tab';
  /** @throws WirebenchError `plugin-error` for a plugin's generator */
  generate(request: CodeRequest, options?: CodeOptions): GeneratedCode | Promise<GeneratedCode>;
}

/**
 * What a registry is built from.
 *
 * @internal Exported for the engine's own hosts.
 */
export interface ExtensionContributions {
  readonly importers?: readonly ImporterContribution[];
  readonly reporters?: readonly ReporterContribution[];
  readonly codeGenerators?: readonly CodeGeneratorContribution[];
}

/**
 * The contributions of one host. Each list holds the enabled entries only, in registration order;
 * the lookups tell an entry that is off apart from one that does not exist.
 *
 * @internal Exported for the engine's own hosts; the plugin API is `@wirebench/engine/plugin`.
 */
export interface ExtensionRegistry {
  readonly importers: readonly ImporterContribution[];
  readonly reporters: readonly ReporterContribution[];
  readonly codeGenerators: readonly CodeGeneratorContribution[];
  /** @throws WirebenchError `feature-disabled` | `contribution-unknown` */
  importer(id: string): ImporterContribution;
  /** @throws WirebenchError `feature-disabled` | `contribution-unknown` */
  reporter(id: string): ReporterContribution;
  /** @throws WirebenchError `feature-disabled` | `contribution-unknown` */
  codeGenerator(id: string): CodeGeneratorContribution;
}

const BUILTIN_ID = /^[a-z0-9][a-z0-9-]*$/;
const PLUGIN_ID = /^[a-z0-9][a-z0-9-]{1,62}\/[a-z0-9][a-z0-9-]*$/;

type Point = 'importer' | 'reporter' | 'code generator';

function checkIds(point: Point, entries: readonly ContributionBase[]): void {
  const seen = new Set<string>();
  for (const entry of entries) {
    const pattern = entry.origin.kind === 'builtin' ? BUILTIN_ID : PLUGIN_ID;
    if (!pattern.test(entry.id)) {
      throw new Error(`createExtensionRegistry: "${entry.id}" is not a valid ${point} id`);
    }
    if (entry.origin.kind === 'plugin' && !entry.id.startsWith(`${entry.origin.plugin}/`)) {
      throw new Error(`createExtensionRegistry: "${entry.id}" is not namespaced by its plugin`);
    }
    if (seen.has(entry.id)) {
      throw new Error(`createExtensionRegistry: two ${point}s "${entry.id}"`);
    }
    seen.add(entry.id);
  }
}

/**
 * Builds a registry from `contributions`, with each entry's feature read from `features`.
 *
 * @throws Error for a malformed or duplicate id
 * @internal Exported for the engine's own hosts.
 */
export function createExtensionRegistry(
  contributions: ExtensionContributions,
  features: FeatureSet,
): ExtensionRegistry {
  const importers = contributions.importers ?? [];
  const reporters = contributions.reporters ?? [];
  const codeGenerators = contributions.codeGenerators ?? [];
  checkIds('importer', importers);
  checkIds('reporter', reporters);
  checkIds('code generator', codeGenerators);
  const on = (entry: ContributionBase): boolean => entry.feature === undefined || features.isEnabled(entry.feature);
  const lookup = <T extends ContributionBase>(point: Point, entries: readonly T[], id: string): T => {
    const entry = entries.find((candidate) => candidate.id === id);
    if (entry === undefined) {
      throw new WirebenchError('contribution-unknown', `There is no ${point} "${id}"`, {
        details: { point, id, known: entries.filter(on).map((candidate) => candidate.id) },
      });
    }
    if (!on(entry)) throw featureDisabled(features, entry.feature as string);
    return entry;
  };
  return {
    importers: importers.filter(on),
    reporters: reporters.filter(on),
    codeGenerators: codeGenerators.filter(on),
    importer: (id) => lookup('importer', importers, id),
    reporter: (id) => lookup('reporter', reporters, id),
    codeGenerator: (id) => lookup('code generator', codeGenerators, id),
  };
}
