/**
 * Running a gRPC schema import in main: reading what the user pointed at, in whichever of the five
 * ways they did, and handing the engine either an import-path-keyed map of `.proto` text or the
 * descriptors a server sent.
 *
 * A folder is walked for every `.proto` beneath it and each file keyed by its path relative to the
 * folder — the import root convention — so `import "a/b.proto"` resolves exactly as it would for a
 * compiler run from that folder. Picked files are keyed by their base name, and by their path
 * relative to their common ancestor when that differs. A URL fetches the root file and then every
 * relative import beside it, so a service that publishes its protos over HTTP imports in one step.
 * A running server is asked to describe itself over server reflection, which is the one source with
 * no `.proto` text at all: what comes back is the compiler's own output, and it is kept as such.
 * Nothing is written here: placing the API and caching what it was built from is the project's job.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import {
  apiFromProtoSet,
  defaultTlsFor,
  descriptorSetBytes,
  importProto,
  ProtoError,
  reflectProtoSet,
  WirebenchError,
} from '@wirebench/engine';
import type { ImportedProto, ProtoSet, ProtoSources, TlsOptions } from '@wirebench/engine';
import type { EngineProgressEvent, ProtoSourceWire } from '../shared/wire-types.js';

/** What one import needs beyond where to read from. */
export interface RunProtoImportInput {
  readonly source: ProtoSourceWire;
  readonly token?: string;
  readonly name?: string;
  readonly target?: string;
  readonly tls?: boolean;
}

/** Hooks one import reports through. */
export interface RunProtoImportHooks {
  readonly onProgress?: (event: EngineProgressEvent) => void;
}

/** What one import produced besides the API: the form its definition is cached in. */
export type ProtoImportDefinition =
  | { readonly kind: 'proto'; readonly sources: ProtoSources }
  | {
      readonly kind: 'reflection';
      /** The `FileDescriptorSet` the server described itself with, ready to cache byte for byte. */
      readonly descriptors: Uint8Array;
      /** The version that answered, which an `auto` discovery resolved to. */
      readonly version: 'v1' | 'v1alpha';
      readonly trustInvalid: boolean;
    };

/** The result of one import: the mapped API, what it was built from, and how it was named. */
export type ProtoImportRun = {
  readonly imported: ImportedProto;
  readonly roots: readonly string[];
  /** Where the user pointed at, as they gave it, for the API's definition record. */
  readonly sourceLabel: string;
} & ProtoImportDefinition;

/** What {@link ProtoImportService.read} found, before anything is mapped to an API. */
type ProtoRead = { readonly roots: readonly string[]; readonly label: string; readonly count: number } & (
  | { readonly kind: 'proto'; readonly sources: Map<string, string> }
  | {
      readonly kind: 'reflection';
      readonly set: ProtoSet;
      readonly descriptors: Uint8Array;
      readonly version: 'v1' | 'v1alpha';
      readonly trustInvalid: boolean;
    }
);

/** Fetches one URL as text; injectable so tests need no network. */
export type FetchText = (url: string, signal: AbortSignal) => Promise<string>;

/**
 * The TLS material a discovery should use, resolved in main: the configured trust anchors, and
 * `rejectUnauthorized: false` when the user asked to reach a server whose certificate does not
 * verify. Injectable so a test needs no preferences.
 */
export type GrpcDiscoveryTls = (options: { readonly trustInvalid: boolean }) => Promise<TlsOptions | undefined>;

/** How long a discovery waits for the server to describe itself. */
const REFLECTION_TIMEOUT_MS = 30_000;

const defaultFetchText: FetchText = async (url, signal) => {
  const response = await fetch(url, { signal });
  if (!response.ok) {
    throw new WirebenchError('proto-fetch-failed', `${url} answered ${String(response.status)}`, {
      details: { url, status: response.status },
    });
  }
  return await response.text();
};

/** How many files a folder import will read before giving up: a vendored tree is not a definition. */
const MAX_PROTO_FILES = 2000;

/** Every `.proto` under `dir`, keyed by `/`-separated path relative to it. */
async function readFolder(dir: string, signal: AbortSignal): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  const walk = async (current: string, prefix: string): Promise<void> => {
    signal.throwIfAborted();
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') {
        continue;
      }
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(path, `${prefix}${entry.name}/`);
      } else if (entry.isFile() && entry.name.endsWith('.proto')) {
        if (files.size >= MAX_PROTO_FILES) {
          throw new ProtoError(
            'proto-too-many-files',
            `More than ${String(MAX_PROTO_FILES)} .proto files under ${dir}`,
            {
              details: { dir },
            },
          );
        }
        files.set(`${prefix}${entry.name}`, await readFile(path, 'utf8'));
      }
    }
  };
  await walk(dir, '');
  if (files.size === 0) {
    throw new ProtoError('proto-no-roots', `No .proto files under ${dir}`, { details: { dir } });
  }
  return files;
}

/** The deepest directory every path shares. */
function commonDir(paths: readonly string[]): string {
  let common = dirname(paths[0] ?? '');
  for (const path of paths.slice(1)) {
    while (!dirname(path).startsWith(common)) {
      const parent = dirname(common);
      if (parent === common) {
        break;
      }
      common = parent;
    }
  }
  return common;
}

/**
 * Picked files, keyed by path relative to their common ancestor, plus — transitively — every file
 * they import that sits on disk beside them: under the common ancestor (the import-root reading) or
 * next to the importer (the relative reading). A `.proto` the user picked is the root of its own
 * definition, and its imports are as much a part of that definition as a WSDL's `xsd:import`s are;
 * only the bundled `google/protobuf/*` are left to the engine. An import that is nowhere on disk
 * is left for the loader to report as missing, by name.
 */
async function readFiles(paths: readonly string[]): Promise<{ sources: Map<string, string>; roots: string[] }> {
  const resolved = paths.map((path) => resolve(path));
  const base = commonDir(resolved);
  const sources = new Map<string, string>();
  const roots: string[] = [];
  const queue: { key: string; path: string }[] = [];
  for (const path of resolved) {
    const key = relative(base, path).split(sep).join('/');
    queue.push({ key, path });
    roots.push(key);
  }
  while (queue.length > 0) {
    const next = queue.shift()!;
    if (sources.has(next.key)) continue;
    if (sources.size >= MAX_PROTO_FILES) {
      throw new ProtoError('proto-too-many-files', `More than ${String(MAX_PROTO_FILES)} .proto files imported`, {
        details: { count: sources.size },
      });
    }
    const text = await readFile(next.path, 'utf8');
    sources.set(next.key, text);
    for (const imported of importsOf(text)) {
      if (imported.startsWith('google/protobuf/') || sources.has(imported)) continue;
      const candidates = [join(base, imported), join(dirname(next.path), imported)];
      for (const candidate of candidates) {
        const found = await stat(candidate).then(
          (info) => info.isFile(),
          () => false,
        );
        if (found) {
          queue.push({ key: imported, path: candidate });
          break;
        }
      }
    }
  }
  const importedKeys = new Set([...sources.values()].flatMap(importsOf));
  const topLevel = roots.filter((key) => !importedKeys.has(key));
  return { sources, roots: topLevel.length > 0 ? topLevel : roots };
}

/** The `import "…";` targets a `.proto` names, in order. */
function importsOf(text: string): string[] {
  return [...text.matchAll(/^\s*import\s+(?:public\s+|weak\s+)?"([^"]+)"\s*;/gm)].map((match) => match[1]!);
}

/**
 * Fetches the root file and, transitively, every relative import beside it. Bundled well-known
 * imports (`google/protobuf/*`) are left to the engine.
 */
async function readUrl(url: string, fetchText: FetchText, signal: AbortSignal, progress: (message: string) => void) {
  const root = new URL(url);
  const rootName = basename(root.pathname);
  const base = new URL('./', root);
  const sources = new Map<string, string>();
  const queue: { readonly key: string; readonly location: URL }[] = [{ key: rootName, location: root }];
  while (queue.length > 0) {
    const next = queue.shift()!;
    if (sources.has(next.key)) {
      continue;
    }
    progress(`Fetching ${next.location.href}`);
    const text = await fetchText(next.location.href, signal);
    sources.set(next.key, text);
    for (const target of importsOf(text)) {
      if (target.startsWith('google/protobuf/') || sources.has(target)) {
        continue;
      }
      queue.push({ key: target, location: new URL(target, base) });
    }
  }
  return { sources, roots: [rootName] };
}

/**
 * Owns the in-flight `.proto` imports of the session, one controller per token, as the OpenAPI
 * import service does.
 */
export class ProtoImportService {
  private readonly inFlight = new Map<string, AbortController>();
  private readonly fetchText: FetchText;
  private readonly grpcTls: GrpcDiscoveryTls;

  constructor(options?: { readonly fetchText?: FetchText; readonly grpcTls?: GrpcDiscoveryTls }) {
    this.fetchText = options?.fetchText ?? defaultFetchText;
    this.grpcTls = options?.grpcTls ?? (() => Promise.resolve(undefined));
  }

  /**
   * Reads the source and maps it to an API.
   *
   * @throws ProtoError as the engine's loader does; `proto-fetch-failed` for a URL that did not answer
   */
  async run(input: RunProtoImportInput, hooks: RunProtoImportHooks = {}): Promise<ProtoImportRun> {
    const controller = new AbortController();
    const token = input.token;
    if (token !== undefined) {
      this.inFlight.get(token)?.abort();
      this.inFlight.set(token, controller);
    }
    const progress = (phase: EngineProgressEvent['phase'], message: string): void => {
      hooks.onProgress?.({ kind: 'import', phase, message, ...(token !== undefined ? { token } : {}) });
    };
    try {
      progress('fetch', input.source.kind === 'reflection' ? 'Asking the server' : 'Reading .proto files');
      const read = await this.read(input.source, controller.signal, (message) => progress('fetch', message));
      progress('parse', `Parsing ${String(read.count)} file${read.count === 1 ? '' : 's'}`);
      const options = {
        roots: read.roots,
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.target !== undefined ? { target: input.target } : {}),
        ...(input.tls !== undefined ? { tls: input.tls } : {}),
      };
      // A discovery has already resolved its schema; only an import still has text to parse.
      const imported = read.kind === 'proto' ? importProto(read.sources, options) : apiFromProtoSet(read.set, options);
      progress(
        'done',
        read.kind === 'proto'
          ? `Imported ${String(imported.summary.methods)} methods`
          : `Discovered ${String(imported.summary.methods)} methods`,
      );
      const definition: ProtoImportDefinition =
        read.kind === 'proto'
          ? { kind: 'proto', sources: read.sources }
          : {
              kind: 'reflection',
              descriptors: read.descriptors,
              version: read.version,
              trustInvalid: read.trustInvalid,
            };
      return { imported, roots: read.roots, sourceLabel: read.label, ...definition };
    } finally {
      if (token !== undefined && this.inFlight.get(token) === controller) {
        this.inFlight.delete(token);
      }
    }
  }

  private async read(
    source: ProtoSourceWire,
    signal: AbortSignal,
    progress: (message: string) => void,
  ): Promise<ProtoRead> {
    switch (source.kind) {
      case 'folder': {
        const dir = resolve(source.path);
        if (!(await stat(dir)).isDirectory()) {
          throw new ProtoError('proto-source-invalid', `${source.path} is not a folder`, {
            details: { path: source.path },
          });
        }
        const sources = await readFolder(dir, signal);
        // Every file that nothing else imports is a root, so a folder of independent services imports whole.
        const imported = new Set([...sources.values()].flatMap(importsOf));
        const roots = [...sources.keys()].filter((key) => !imported.has(key));
        return {
          kind: 'proto',
          sources,
          roots: roots.length > 0 ? roots : [...sources.keys()],
          label: source.path,
          count: sources.size,
        };
      }
      case 'files': {
        const { sources, roots } = await readFiles(source.paths);
        return {
          kind: 'proto',
          sources,
          roots,
          label: source.paths.length === 1 ? source.paths[0]! : commonDir(source.paths.map((p) => resolve(p))),
          count: sources.size,
        };
      }
      case 'text': {
        const name =
          source.filename !== undefined && source.filename !== '' ? basename(source.filename) : 'pasted.proto';
        return {
          kind: 'proto',
          sources: new Map([[name, source.text]]),
          roots: [name],
          label: source.filename ?? 'inline:proto',
          count: 1,
        };
      }
      case 'url': {
        const { sources, roots } = await readUrl(source.url, this.fetchText, signal, progress);
        return { kind: 'proto', sources, roots, label: source.url, count: sources.size };
      }
      case 'reflection': {
        const trustInvalid = source.trustInvalid === true;
        const tlsOptions = await this.grpcTls({ trustInvalid });
        progress(`Asking ${source.target} to describe itself`);
        const discovered = await reflectProtoSet({
          target: source.target,
          tls: source.tls ?? defaultTlsFor(source.target),
          metadata: [],
          timeoutMs: REFLECTION_TIMEOUT_MS,
          signal,
          ...(source.version !== undefined ? { version: source.version } : {}),
          ...(tlsOptions !== undefined ? { tlsOptions } : {}),
        });
        return {
          kind: 'reflection',
          set: discovered.set,
          // Cached exactly as the loaded set is ordered, so a reload resolves as this discovery did.
          descriptors: descriptorSetBytes(discovered.files),
          version: discovered.version,
          trustInvalid,
          roots: discovered.roots,
          label: source.target,
          count: discovered.files.size,
        };
      }
    }
  }

  /** Aborts the import running under `token`, if one still is. */
  cancel(token: string): { readonly cancelled: boolean } {
    const controller = this.inFlight.get(token);
    if (controller === undefined) {
      return { cancelled: false };
    }
    controller.abort();
    this.inFlight.delete(token);
    return { cancelled: true };
  }

  /** Aborts every in-flight import. */
  cancelAll(): void {
    for (const controller of this.inFlight.values()) {
      controller.abort();
    }
    this.inFlight.clear();
  }
}
