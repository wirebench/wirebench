/**
 * Installed plugins composed into a host's registry (phase 7 spec §4, §7, §8; ADR-0031). Each plugin
 * becomes a `plugin:<id>` feature that needs `plugins`, and each of its contributions an entry whose
 * calls run in the plugin sandbox: `detect` on at most the first 1 MiB within 1 s, everything else
 * within 60 s. An importer of a plugin that lists origins gets the brokered network; nothing else
 * does. A reporter is handed the masked run as the plugin API's `RunReport`, without exchanges; a code
 * generator a `CodeRequest` whose credentials are environment reads.
 */
import { WirebenchError } from '#core/errors';
import type {
  CodeGeneratorContribution,
  ExtensionContributions,
  ImporterContribution,
  ReporterContribution,
} from '#core/extension/registry';
import type { PluginManifestData } from '#core/extension/plugin/manifest';
import { createPluginNet, type PluginNetOptions } from '#core/extension/plugin/net';
import { checkImportResult, detectResultSchema, generatedCodeSchema } from '#core/extension/plugin/results';
import { createPluginSandbox, type PluginSandbox } from '#core/extension/plugin/sandbox/host';
import { PLUGIN_LIMITS, type PluginJob } from '#core/extension/plugin/sandbox/model';
import type { InstalledPlugin } from '#core/extension/plugin/store';
import type { CodeOptions, CodeRequest as EngineCodeRequest, TextPart } from '#core/http/codegen/index';
import { splitEnv } from '#core/http/codegen/index';
import { indentUnit } from '#core/http/codegen/text';
import type { FeatureDescriptor } from '#core/protocol/features';
import { toJsonReport } from '#core/run/report';
import type { RunResult } from '#core/run/run';
import type { CodeBody, CodeRequest, Layout, RunReport, Text } from './plugin.js';

/** The switch that covers every plugin: a team policy can name it to keep plugins out. */
export const PLUGINS_FEATURE: FeatureDescriptor = {
  id: 'plugins',
  title: 'Plugins',
  default: true,
  stage: 'stable',
  requires: [],
};

/** A plugin's own switch, `plugin:<id>`. */
export function pluginFeature(manifest: PluginManifestData): FeatureDescriptor {
  return { id: `plugin:${manifest.id}`, title: manifest.name, default: true, stage: 'stable', requires: ['plugins'] };
}

// ─── What a plugin is handed ─────────────────────────────────────────────────────────────────────

/** The masked run as the plugin API's `RunReport`: outcomes, no traffic. */
export function toPluginReport(
  result: RunResult,
  tool: { readonly name: string; readonly version: string },
): RunReport {
  const json = toJsonReport(result, tool);
  const { total, passed, failed, errored, skipped, durationMs } = json.summary;
  return {
    formatVersion: 1,
    tool: json.tool,
    startedAt: json.startedAt,
    ...(json.environment !== undefined ? { environment: json.environment } : {}),
    summary: { total, passed, failed, errored, skipped, durationMs },
    requests: json.requests.map((request) => ({
      path: request.path,
      group: request.group,
      name: request.name,
      protocol: request.protocol,
      outcome: request.outcome,
      ...(request.status !== undefined ? { status: request.status } : {}),
      ...(request.durationMs !== undefined ? { durationMs: request.durationMs } : {}),
      unasserted: request.unasserted,
      assertions: request.assertions.map((assertion) => ({
        type: assertion.type,
        label: assertion.label,
        outcome: assertion.outcome,
        ...(assertion.expected !== undefined ? { expected: assertion.expected } : {}),
        ...(assertion.actual !== undefined ? { actual: assertion.actual } : {}),
        ...(assertion.message !== undefined ? { message: assertion.message } : {}),
      })),
      ...(request.error !== undefined ? { error: { code: request.error.code, message: request.error.message } } : {}),
      ...(request.sequence !== undefined ? { sequence: request.sequence } : {}),
      ...(request.iteration !== undefined ? { iteration: request.iteration } : {}),
    })),
  };
}

/** Header names whose value a plugin generator only ever sees as an environment read. */
const CREDENTIAL_HEADERS = new Set(['authorization', 'proxy-authorization', 'cookie']);

const envName = (what: string): string => `WIREBENCH_${what.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;

/** Text with a literal part becomes one environment read: a credential never reaches a plugin as text. */
function credential(text: string, name: string, notes: string[]): Text {
  const parts = splitEnv(text);
  if (parts.every((part) => 'env' in part)) return parts;
  notes.push(`${name} is read from ${envName(name)}.`);
  return [{ env: envName(name) }];
}

const textOf = (text: string): Text => splitEnv(text) satisfies TextPart[];

/** The request a plugin generator sees, and the notes the host adds for what it hid. */
export function toPluginCodeRequest(request: EngineCodeRequest): { request: CodeRequest; notes: string[] } {
  const notes: string[] = [];
  const body: CodeBody =
    request.body.kind === 'none' || request.body.kind === 'binary'
      ? request.body
      : request.body.kind === 'raw'
        ? { kind: 'raw', text: textOf(request.body.text) }
        : request.body.kind === 'form'
          ? {
              kind: 'form',
              fields: request.body.fields.map((field) => ({ name: field.name, value: textOf(field.value) })),
            }
          : {
              kind: 'multipart',
              parts: request.body.parts.map((part) =>
                part.kind === 'text' ? { ...part, value: textOf(part.value) } : part,
              ),
            };
  return {
    request: {
      method: request.method,
      url: textOf(request.url),
      headers: request.headers.map((header) => ({
        name: header.name,
        value: CREDENTIAL_HEADERS.has(header.name.toLowerCase())
          ? credential(header.value, `header ${header.name}`, notes)
          : textOf(header.value),
      })),
      body,
      ...(request.basic !== undefined
        ? {
            basic: {
              username: textOf(request.basic.username),
              password: credential(request.basic.password, 'basic password', notes),
            },
          }
        : {}),
      ...(request.insecure !== undefined ? { insecure: request.insecure } : {}),
      followRedirects: request.followRedirects,
      ...(request.maxRedirects !== undefined ? { maxRedirects: request.maxRedirects } : {}),
      ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}),
    },
    notes,
  };
}

function layoutFor(request: EngineCodeRequest, options: CodeOptions = {}): Layout {
  const followRedirects = options.followRedirects ?? request.followRedirects;
  const timeoutMs = options.timeoutMs ?? request.timeoutMs;
  return {
    unit: indentUnit(options.indent ?? 2),
    followRedirects,
    ...(followRedirects && request.maxRedirects !== undefined ? { maxRedirects: request.maxRedirects } : {}),
    ...(timeoutMs !== undefined && timeoutMs > 0 ? { timeoutMs } : {}),
  };
}

// ─── The contributions ───────────────────────────────────────────────────────────────────────────

export interface PluginHostOptions {
  /** The host's proxy and TLS for a URL; see `PluginNetOptions.network`. */
  readonly network?: PluginNetOptions['network'];
  /** Where each brokered exchange is recorded. */
  readonly record?: PluginNetOptions['record'];
  /** One line a plugin logged, for the host's own log. */
  readonly log?: (plugin: string, line: string) => void;
  /** The sandbox; tests substitute one. */
  readonly sandbox?: PluginSandbox;
}

export interface PluginHost {
  readonly contributions: ExtensionContributions;
  /** Each plugin's own switch, for the registry's feature set; `plugins` itself is built in. */
  readonly features: readonly FeatureDescriptor[];
  dispose(): Promise<void>;
}

function pluginError(
  manifest: PluginManifestData,
  contribution: string,
  cause: string,
  message: string,
): WirebenchError {
  return new WirebenchError('plugin-error', `${manifest.name} (${manifest.id}/${contribution}): ${message}`, {
    details: { plugin: manifest.id, contribution, cause },
  });
}

/**
 * The contributions and switches of `plugins`, calling into one sandbox. The sandbox's worker starts
 * on the first call, so a process that never calls a plugin never starts one.
 */
export function createPluginHost(plugins: readonly InstalledPlugin[], options: PluginHostOptions = {}): PluginHost {
  const brokers = new Map(
    plugins
      .filter((plugin) => (plugin.manifest.capabilities?.network?.length ?? 0) > 0)
      .map((plugin) => [
        plugin.manifest.id,
        createPluginNet({
          plugin: plugin.manifest.id,
          origins: plugin.manifest.capabilities?.network ?? [],
          ...(options.network !== undefined ? { network: options.network } : {}),
          ...(options.record !== undefined ? { record: options.record } : {}),
        }),
      ]),
  );
  const sandbox = options.sandbox ?? createPluginSandbox({ fetchFor: (pluginId) => brokers.get(pluginId)?.forCall() });

  const call = async (
    plugin: InstalledPlugin,
    job: Omit<PluginJob, 'pluginId' | 'code' | 'net' | 'timeoutMs'> & {
      readonly net?: boolean;
      readonly timeoutMs?: number;
    },
  ): Promise<unknown> => {
    const result = await sandbox.run({
      pluginId: plugin.manifest.id,
      code: plugin.code,
      net: false,
      timeoutMs: PLUGIN_LIMITS.callMs,
      ...job,
    });
    for (const line of result.log) options.log?.(plugin.manifest.id, line);
    if (!result.ok) throw pluginError(plugin.manifest, job.contribution, result.cause, result.message);
    return result.value;
  };

  const importers: ImporterContribution[] = [];
  const reporters: ReporterContribution[] = [];
  const codeGenerators: CodeGeneratorContribution[] = [];
  for (const plugin of plugins) {
    const { manifest } = plugin;
    const origin = { kind: 'plugin', plugin: manifest.id } as const;
    const feature = `plugin:${manifest.id}`;
    const net = brokers.has(manifest.id);
    for (const declared of manifest.contributes.importers ?? []) {
      importers.push({
        id: `${manifest.id}/${declared.id}`,
        title: declared.title,
        origin,
        feature,
        ...(declared.extensions !== undefined ? { extensions: declared.extensions } : {}),
        async detect(source) {
          const text =
            source.text.length > PLUGIN_LIMITS.detectBytes
              ? source.text.slice(0, PLUGIN_LIMITS.detectBytes)
              : source.text;
          try {
            const value = await call(plugin, {
              point: 'importers',
              contribution: declared.id,
              method: 'detect',
              args: [{ filename: source.filename ?? '', text }],
              timeoutMs: PLUGIN_LIMITS.detectMs,
            });
            const parsed = detectResultSchema.safeParse(value);
            return parsed.success ? parsed.data : null;
          } catch {
            // A detector that fails says nothing about the file.
            return null;
          }
        },
        async import(source) {
          const value = await call(plugin, {
            point: 'importers',
            contribution: declared.id,
            method: 'import',
            args: [{ filename: source.filename ?? '', text: source.text }],
            net,
          });
          const checked = checkImportResult(value);
          if (!checked.ok)
            throw pluginError(manifest, declared.id, 'error', `returned no valid import: ${checked.message}`);
          return checked.result;
        },
      });
    }
    for (const declared of manifest.contributes.reporters ?? []) {
      reporters.push({
        id: `${manifest.id}/${declared.id}`,
        title: declared.title,
        origin,
        feature,
        extension: declared.extension,
        async render(result, tool) {
          const value = await call(plugin, {
            point: 'reporters',
            contribution: declared.id,
            method: 'render',
            args: [toPluginReport(result, tool)],
          });
          if (typeof value !== 'string') throw pluginError(manifest, declared.id, 'error', 'returned no text');
          return value;
        },
      });
    }
    for (const declared of manifest.contributes.codeGenerators ?? []) {
      codeGenerators.push({
        id: `${manifest.id}/${declared.id}`,
        title: declared.title,
        origin,
        feature,
        language: declared.language,
        indent: 2,
        async generate(request, codeOptions) {
          const { request: seen, notes } = toPluginCodeRequest(request);
          const value = await call(plugin, {
            point: 'codeGenerators',
            contribution: declared.id,
            method: 'generate',
            args: [seen, layoutFor(request, codeOptions)],
          });
          const parsed = generatedCodeSchema.safeParse(value);
          if (!parsed.success) throw pluginError(manifest, declared.id, 'error', 'returned no { code, notes }');
          return { code: parsed.data.code, notes: [...notes, ...parsed.data.notes] };
        },
      });
    }
  }
  return {
    contributions: { importers, reporters, codeGenerators },
    features: plugins.map((plugin) => pluginFeature(plugin.manifest)),
    dispose: () => sandbox.dispose(),
  };
}

/** What plugin detection found for a file no built-in format claims. */
export type PluginDetection =
  | { readonly kind: 'none' }
  | { readonly kind: 'found'; readonly importer: ImporterContribution; readonly confidence: 'definite' | 'probable' }
  /** Two or more importers are equally sure: the person picks, nothing is guessed. */
  | { readonly kind: 'ambiguous'; readonly importers: readonly ImporterContribution[] };

/**
 * Asks every enabled plugin importer about `source`. Run only after the built-in detection said
 * `unknown`, so a plugin never takes a format from its built-in importer (spec §3.1).
 */
export async function detectPluginFormat(
  importers: readonly ImporterContribution[],
  source: { readonly filename?: string; readonly text: string },
): Promise<PluginDetection> {
  const definite: ImporterContribution[] = [];
  const probable: ImporterContribution[] = [];
  for (const importer of importers) {
    if (importer.origin.kind !== 'plugin' || importer.detect === undefined) continue;
    const said = await importer.detect(source);
    if (said === 'definite') definite.push(importer);
    else if (said === 'probable') probable.push(importer);
  }
  const best = definite.length > 0 ? definite : probable;
  const [first] = best;
  if (first === undefined) return { kind: 'none' };
  if (best.length > 1) return { kind: 'ambiguous', importers: best };
  return { kind: 'found', importer: first, confidence: definite.length > 0 ? 'definite' : 'probable' };
}
