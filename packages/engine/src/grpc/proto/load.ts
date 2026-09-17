/**
 * Loading a set of `.proto` sources into one resolved schema.
 *
 * The engine never reads a file on its own here: the caller hands over every source it has, keyed
 * by import path, and this module parses them, follows `import` statements through that map (and
 * through the well-known `google/protobuf/*` definitions bundled with the parser), and resolves
 * every type reference. What comes out is a {@link ProtoSet} the describe, sample and codec
 * modules all read from, so a `.proto` is parsed once per import or send and never re-read.
 */

import protobuf from 'protobufjs';
import { ProtoError } from '../../errors.js';

/** `.proto` sources keyed by the import path other files use to reach them (`/`-separated). */
export type ProtoSources = ReadonlyMap<string, string>;

/** A parsed and resolved set of `.proto` files. */
export interface ProtoSet {
  /** The resolved namespace tree. Readers use the describe and codec modules rather than this directly. */
  readonly root: protobuf.Root;
  /** Every file that took part, roots first, in load order; the bundled well-known files included. */
  readonly files: readonly string[];
  /** The import paths the load started from. */
  readonly roots: readonly string[];
}

/** Options for {@link loadProtoSet}. */
export interface LoadProtoOptions {
  /** The files to start from; each must be a key of the sources. Defaults to every source. */
  readonly roots?: readonly string[];
}

/** The `google/protobuf/*.proto` files the parser bundles, keyed by import path. */
function bundledCommon(path: string): protobuf.INamespace | undefined {
  const common = protobuf.common as unknown as Record<string, protobuf.INamespace | undefined>;
  return Object.hasOwn(common, path) ? common[path] : undefined;
}

/**
 * Finds the source an `import` names. The canonical rule is "relative to a proto root", so the
 * verbatim path wins; a path relative to the importing file's directory comes second, and a
 * unique suffix match last — a user who picked files from nested directories should not have to
 * rearrange them to satisfy the import root convention.
 */
function resolveImport(sources: ProtoSources, importedBy: string, target: string): string | undefined {
  if (sources.has(target)) {
    return target;
  }
  const dir = importedBy.includes('/') ? importedBy.slice(0, importedBy.lastIndexOf('/') + 1) : '';
  const relative = normalisePath(`${dir}${target}`);
  if (sources.has(relative)) {
    return relative;
  }
  const suffix = `/${target}`;
  const candidates = [...sources.keys()].filter((key) => key.endsWith(suffix));
  return candidates.length === 1 ? candidates[0] : undefined;
}

/** Collapses `.` and `..` segments of a `/`-separated path. */
function normalisePath(path: string): string {
  const out: string[] = [];
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') {
      continue;
    }
    if (segment === '..') {
      out.pop();
      continue;
    }
    out.push(segment);
  }
  return out.join('/');
}

/**
 * Parses and resolves `sources`, starting from `roots`.
 *
 * @throws ProtoError `proto-parse` when a file does not parse (`details.file`, `details.line` when
 * the parser reports one); `proto-import-missing` when an `import` names a file that is neither in
 * the sources nor bundled; `proto-unresolved` when a type reference resolves to nothing;
 * `proto-no-roots` when there is nothing to load.
 */
export function loadProtoSet(sources: ProtoSources, options: LoadProtoOptions = {}): ProtoSet {
  const roots = options.roots ?? [...sources.keys()];
  if (roots.length === 0) {
    throw new ProtoError('proto-no-roots', 'No .proto files to load');
  }
  const root = new protobuf.Root();
  const loaded = new Set<string>();
  const order: string[] = [];

  const load = (path: string, importedBy: string | undefined): void => {
    if (loaded.has(path)) {
      return;
    }
    loaded.add(path);
    order.push(path);
    const source = sources.get(path);
    if (source === undefined) {
      const bundled = bundledCommon(path);
      if (bundled !== undefined) {
        root.addJSON(bundled.nested ?? {});
        return;
      }
      throw new ProtoError(
        'proto-import-missing',
        importedBy === undefined
          ? `${path} is not among the .proto files`
          : `${importedBy} imports ${path}, which is not among the .proto files`,
        { details: { file: path, ...(importedBy !== undefined ? { importedBy } : {}) } },
      );
    }
    let parsed: protobuf.IParserResult;
    try {
      parsed = protobuf.parse(source, root, { keepCase: true, alternateCommentMode: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const line = /\(line (\d+)\)/.exec(message)?.[1];
      throw new ProtoError('proto-parse', `${path}: ${message}`, {
        cause: error,
        details: { file: path, ...(line !== undefined ? { line: Number(line) } : {}) },
      });
    }
    for (const target of [...(parsed.imports ?? []), ...(parsed.weakImports ?? [])]) {
      const resolved = resolveImport(sources, path, target) ?? target;
      load(resolved, path);
    }
  };

  for (const path of roots) {
    load(path, undefined);
  }
  try {
    root.resolveAll();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ProtoError('proto-unresolved', message, { cause: error });
  }
  return { root, files: order, roots };
}
