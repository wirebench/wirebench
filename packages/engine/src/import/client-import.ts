/**
 * What every importer of another request client's export hands its host (spec §3.1): the APIs per
 * source collection, the variable plan, the scripts kept as text and the report. The desktop main
 * process and the CLI place it the same way for every format.
 */

import type { MappedCollectionV3Entry } from './collection-v3/map.js';
import type { ImportReport, ReportBuilder } from './report.js';
import type { ImportedScriptFile } from './scripts.js';
import { importedScriptPath } from './scripts.js';
import type { ImportedVariables } from './variables.js';

export type ClientFormat = 'insomnia' | 'bruno' | 'hoppscotch' | 'thunder-client';

/** The `.proto` texts a gRPC API's definition is loaded from, by root-relative name. */
export interface MappedProtoSet {
  readonly sources: ReadonlyMap<string, string>;
  /** The files that hold the services, of `sources`' names. */
  readonly roots: readonly string[];
}

/** One source collection's APIs, as the folder (v3) importer makes them, plus the protos of its gRPC API. */
export interface MappedClientEntry extends MappedCollectionV3Entry {
  /** Present when the export carried the gRPC API's `.proto` files. */
  readonly grpcProtos?: MappedProtoSet;
}

export interface MappedClientImport {
  /** One entry per source collection; each API in it is present only when it has requests. */
  readonly collections: readonly MappedClientEntry[];
  readonly variables: ImportedVariables;
  readonly scripts: readonly ImportedScriptFile[];
  readonly counts: {
    readonly collections: number;
    readonly requests: number;
    readonly folders: number;
    readonly examples: number;
    readonly assertions: number;
    readonly scripts: number;
  };
  /** What the mapping did not bring across; the variable lines are in `variables.report`. */
  readonly report: ImportReport;
}

/** The script APIs a saved script may be written against, by the global it calls. */
const DIALECTS: readonly [RegExp, string][] = [
  [/\bpm\./, 'pm.'],
  [/\binsomnia\./, 'insomnia.'],
  [/\bpw\./, 'pw.'],
  [/\bhopp\./, 'hopp.'],
  [/\bbru\./, 'bru.'],
  [/\btc\./, 'tc.'],
];

/**
 * Saves an importer's scripts as text under `imported-scripts/<api>/` (owner decision 1): none is
 * attached to a request and none is ever run. Each gets a note naming its file.
 */
export class ScriptCollector {
  private readonly taken = new Set<string>();
  private readonly saved: ImportedScriptFile[] = [];
  private readonly dialects = new Set<string>();

  constructor(
    private readonly apiSlug: string,
    private readonly report: ReportBuilder,
  ) {}

  /** Saves non-empty `source` as `imported-scripts/<apiSlug>/<itemSlug>.<phase>.js`. */
  add(itemSlug: string, phase: 'pre' | 'post' | 'tests', source: string, label: string): void {
    if (source.trim() === '') return;
    const path = importedScriptPath(this.apiSlug, itemSlug === '' ? 'item' : itemSlug, `${phase}.js`, this.taken);
    this.saved.push({ path, source });
    for (const [pattern, name] of DIALECTS) if (pattern.test(source)) this.dialects.add(name);
    const what = phase === 'pre' ? 'pre-request' : phase === 'post' ? 'after-response' : 'tests';
    this.report.note(`${label}: its ${what} script was saved to ${path} and is never run.`);
  }

  files(): ImportedScriptFile[] {
    return [...this.saved];
  }

  /** One warning naming the script APIs the saved scripts call, so the user knows what to port. */
  reportDialects(): void {
    if (this.dialects.size === 0) return;
    const names = DIALECTS.map(([, name]) => name).filter((name) => this.dialects.has(name));
    this.report.warn(
      `The saved scripts call ${names.join(', ')}; Wirebench does not run them. Port what they do to Wirebench scripts by hand.`,
    );
  }
}

/** Deeper nesting is kept as JSON text under its name rather than flattened further. */
const MAX_FLATTEN_DEPTH = 32;

function scalarText(value: unknown): string | undefined {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  return undefined;
}

/**
 * A variable value as dotted names and text: `{"db":{"host":"x"},"ids":[1]}` under `v` becomes
 * `v.db.host = x` and `v.ids.0 = 1`. Numbers and booleans become strings, `null` an empty string,
 * and an empty object or array its JSON text.
 */
export function flattenValue(name: string, value: unknown, depth = 0): [string, string][] {
  const scalar = scalarText(value);
  if (scalar !== undefined) return [[name, scalar]];
  if (typeof value !== 'object' || value === null) return [[name, String(value)]];
  const entries: [string, unknown][] = Array.isArray(value)
    ? value.map((item: unknown, index): [string, unknown] => [String(index), item])
    : Object.entries(value);
  if (entries.length === 0 || depth >= MAX_FLATTEN_DEPTH) return [[name, JSON.stringify(value)]];
  return entries.flatMap(([key, item]) => flattenValue(`${name}.${key}`, item, depth + 1));
}
