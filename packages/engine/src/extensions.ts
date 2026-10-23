/**
 * The built-in importers, reporters and code generators (phase 7 spec §4), composed here as
 * `protocols.ts` composes the protocols. Each stays where it lives; this file only registers it.
 */
import type {
  CodeGeneratorContribution,
  ExtensionContributions,
  ImporterContribution,
  ReporterContribution,
} from '#core/extension/registry';
import { CODE_TARGETS, defaultIndent, generateCode } from '#core/http/codegen/index';
import type { CodeTargetId } from '#core/http/codegen/index';
import { renderJson } from '#core/run/report';
import type { BuiltinImportFormatKind } from './import-detect.js';

const BUILTIN = { kind: 'builtin' } as const;

/** Each format's title and the switch of the protocol it lands in; no switch for workspace-only ones. */
const IMPORT_FORMATS: readonly (readonly [BuiltinImportFormatKind, string, string | undefined, readonly string[]])[] = [
  ['openapi', 'OpenAPI / Swagger', 'rest', ['.json', '.yaml', '.yml']],
  ['asyncapi', 'AsyncAPI', 'websocket', ['.json', '.yaml', '.yml']],
  ['postman', 'Postman Collection', 'rest', ['.json']],
  ['postman-v3', 'Postman Collection v3 (folder)', 'rest', ['.yaml']],
  ['postman-environment', 'Postman environment', undefined, ['.json']],
  ['postman-globals', 'Postman globals', undefined, ['.json']],
  ['har', 'HAR', 'rest', ['.har', '.json']],
  ['http-file', '.http file', 'rest', ['.http', '.rest']],
  ['http-env', 'HTTP client environment file', undefined, ['.json']],
  ['opencollection', 'OpenCollection', 'rest', ['.yml', '.yaml']],
  ['insomnia', 'Insomnia export', 'rest', ['.json', '.yaml']],
  ['insomnia-environment', 'Insomnia environments', undefined, ['.json', '.yaml']],
  ['bruno', 'Bruno collection', 'rest', ['.json']],
  ['hoppscotch', 'Hoppscotch collection', 'rest', ['.json']],
  ['hoppscotch-environment', 'Hoppscotch environments', undefined, ['.json']],
  ['thunder-client', 'Thunder Client collection', 'rest', ['.json']],
  ['thunder-client-environment', 'Thunder Client environment', undefined, ['.json']],
  ['wsdl', 'WSDL / SOAP', 'soap', ['.wsdl', '.xml']],
  ['proto', 'Protocol Buffers', 'grpc', ['.proto']],
  ['legacy-soap-project', 'Legacy SOAP project', 'soap', ['.xml']],
];

/**
 * The built-in import formats, in the Import dialog's order. Their detection is `detectImportFormat`.
 *
 * @internal Exported for the engine's own hosts.
 */
export const BUILTIN_IMPORTERS: readonly ImporterContribution[] = IMPORT_FORMATS.map(
  ([id, title, feature, extensions]) => ({
    id,
    title,
    origin: BUILTIN,
    extensions,
    ...(feature !== undefined ? { feature } : {}),
  }),
);

/**
 * The `json` report: the engine's own machine format (`run/report.ts`). JUnit and HTML are the CLI's.
 *
 * @internal Exported for the engine's own hosts.
 */
export const BUILTIN_REPORTERS: readonly ReporterContribution[] = [
  { id: 'json', title: 'JSON', origin: BUILTIN, extension: '.json', render: renderJson },
];

/** The editor language each target's output is highlighted as. */
const LANGUAGES: Readonly<Record<CodeTargetId, string>> = {
  'js-fetch': 'javascript',
  'node-axios': 'javascript',
  'python-requests': 'python',
  'go-net-http': 'go',
  'java-httpclient': 'java',
  'java-okhttp': 'java',
  'csharp-httpclient': 'csharp',
  'php-curl': 'php',
  'ruby-net-http': 'ruby',
  'powershell-irm': 'powershell',
  httpie: 'shell',
};

/**
 * The eleven languages of #337, in the Code panel's order.
 *
 * @internal Exported for the engine's own hosts.
 */
export const BUILTIN_CODE_GENERATORS: readonly CodeGeneratorContribution[] = CODE_TARGETS.map((target) => ({
  id: target.id,
  title: target.label,
  origin: BUILTIN,
  language: LANGUAGES[target.id],
  indent: defaultIndent(target.id),
  generate: (request, options) => generateCode(target.id, request, options),
}));

/**
 * Every built-in contribution, with a host's own added after them: the CLI adds its JUnit and HTML
 * reporters, a plugin loader its plugins' entries.
 *
 * @internal Exported for the engine's own hosts.
 */
export function builtinExtensions(extra: ExtensionContributions = {}): ExtensionContributions {
  return {
    importers: [...BUILTIN_IMPORTERS, ...(extra.importers ?? [])],
    reporters: [...BUILTIN_REPORTERS, ...(extra.reporters ?? [])],
    codeGenerators: [...BUILTIN_CODE_GENERATORS, ...(extra.codeGenerators ?? [])],
  };
}
