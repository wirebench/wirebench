/**
 * What every other-client importer (Insomnia, Bruno, Hoppscotch, Thunder Client) returns, plus two
 * helpers they share: a collector that keeps imported scripts as text, and a flattener for nested
 * environment values.
 */
import type { MappedCollectionV3Entry } from './collection-v3/map.js';
import { importedScriptPath } from './scripts.js';
import type { ImportedScriptFile } from './scripts.js';
import type { ImportReport, ReportBuilder } from './report.js';
import type { ImportedVariables } from './variables.js';
import { slugify } from '../project/paths.js';

export type ClientFormat = 'insomnia' | 'bruno' | 'hoppscotch' | 'thunder-client';

export interface MappedClientImport {
  /** Same entry type as the v3 importer: one per source collection, each API present only when it has requests. */
  readonly collections: readonly MappedCollectionV3Entry[];
  readonly variables: ImportedVariables;
  readonly scripts: readonly ImportedScriptFile[];
  /** Root-relative `.proto` paths gRPC requests name (Bruno), or proto texts by name (Insomnia v4). */
  readonly protos: readonly {
    readonly name: string;
    readonly text: string;
    /** Insomnia: the path inside its workspace (directory names, then the file name). */
    readonly path?: string;
    /** Insomnia: the index into `collections` of the workspace that holds it. */
    readonly collection?: number;
  }[];
  readonly counts: {
    readonly collections: number;
    readonly requests: number;
    readonly folders: number;
    readonly examples: number;
    readonly assertions: number;
    readonly scripts: number;
  };
  readonly report: ImportReport;
}

const DIALECTS = ['pm', 'insomnia', 'pw', 'hopp', 'bru', 'tc'] as const;

function isWordChar(ch: string | undefined): boolean {
  return (
    ch !== undefined &&
    ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') || ch === '_' || ch === '$')
  );
}

/** True when `source` holds `name.` as a whole word (the character before it is not part of an identifier). */
function usesDialect(source: string, name: string): boolean {
  const needle = `${name}.`;
  let from = 0;
  for (;;) {
    const at = source.indexOf(needle, from);
    if (at < 0) return false;
    if (!isWordChar(at > 0 ? source[at - 1] : undefined)) return true;
    from = at + 1;
  }
}

/** Saves a client's scripts as text under `imported-scripts/<api>/`, noting which script dialects they use. */
export class ScriptCollector {
  private readonly saved: ImportedScriptFile[] = [];
  private readonly taken = new Set<string>();
  private readonly seen = new Set<string>();

  constructor(
    private readonly apiSlug: string,
    private readonly report: ReportBuilder,
  ) {}

  /** Saves non-empty `source` as `imported-scripts/<apiSlug>/<itemSlug>.<phase>.js`; `phase` is `pre`, `post` or `tests`. */
  add(itemSlug: string, phase: 'pre' | 'post' | 'tests', source: string, label: string): void {
    if (source.trim() === '') return;
    const slug = slugify(itemSlug).toLowerCase();
    const path = importedScriptPath(this.apiSlug, slug === '' ? 'request' : slug, `${phase}.js`, this.taken);
    this.saved.push({ path, source });
    for (const dialect of DIALECTS) if (usesDialect(source, dialect)) this.seen.add(dialect);
    this.report.note(
      `${label}: ${phase === 'pre' ? 'pre-request script' : phase === 'post' ? 'post-response script' : 'tests'} saved as ${path}.`,
    );
  }

  files(): ImportedScriptFile[] {
    return [...this.saved];
  }

  /** One warning naming the dialects seen: `pm.`, `insomnia.`, `pw.`, `hopp.`, `bru.`, `tc.`. */
  reportDialects(): void {
    const names = DIALECTS.filter((d) => this.seen.has(d)).map((d) => `${d}.`);
    if (names.length === 0) return;
    this.report.warn(
      `Imported scripts use ${names.join(', ')} calls from another client; they are kept as text and do not run in Wirebench.`,
    );
  }
}

/** `{"db":{"host":"x"},"ids":[1]}` → [['db.host','x'],['ids.0','1']]; numbers and booleans become strings; null becomes ''. */
export function flattenValue(name: string, value: unknown): [string, string][] {
  if (value === null || value === undefined) return [[name, '']];
  if (typeof value === 'string') return [[name, value]];
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint')
    return [[name, String(value)]];
  if (Array.isArray(value)) return value.flatMap((item, i) => flattenValue(`${name}.${i}`, item));
  if (typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, item]) =>
      flattenValue(`${name}.${key}`, item),
    );
  }
  return [[name, '']];
}
