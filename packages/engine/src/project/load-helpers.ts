/**
 * What core's loader and every protocol's `storage.load` share when they read a project folder:
 * YAML from a relative path, the `undefined`-dropping helpers, authentication as loaded, a
 * request's scripts, and the request tree an API (of any protocol) and the webhook collection keep
 * under `requests/`.
 *
 * A protocol's storage imports this file and never `load.ts`, which imports the protocols.
 */

import { join } from 'node:path';
import type { z } from 'zod';
import type { KeyValueEntry } from '../http/entries.js';
import { scriptFileName } from '../script/model.js';
import type { RequestScripts, ScriptPhase, ScriptSource } from '../script/model.js';
import { SCRIPT_LIMITS } from '../script/sandbox/model.js';
import type { FsLike } from './fs.js';
import { readFileIfExists, readdirIfExists } from './fs.js';
import type { ProjectProblem } from './load.js';
import type { AuthConfig, DefinitionAuth } from './model.js';
import { isExamplesDir } from './managed-files.js';
import { FOLDER_FILE, FOLDER_SCRIPT_STEM, GOLDEN_SUFFIX, MAX_FOLDER_DEPTH, REQUEST_SUFFIX } from './paths.js';
import { parseFile, restFolderFileSchema } from './schema-parts.js';
import type { KeyValueEntryFile, scriptsSchema } from './schema-parts.js';
import { parseYaml } from './yaml.js';

/** The absolute path of a `/`-separated path relative to the project root. */
export function abs(root: string, relative: string): string {
  return join(root, ...relative.split('/'));
}

/** Reads and parses one YAML file of the project; undefined when the file does not exist. */
export async function readYaml(fs: FsLike, root: string, relative: string): Promise<unknown> {
  const buffer = await readFileIfExists(fs, abs(root, relative));
  return buffer === undefined ? undefined : parseYaml(buffer.toString('utf8'), relative);
}

/** Orders entities by their persisted `order`, falling back to a stable name comparison. */
export function byOrder<T extends { readonly order: number; readonly name: string }>(a: T, b: T): number {
  return a.order - b.order || a.name.localeCompare(b.name);
}

/** `{ [key]: value }`, or nothing at all when the value is undefined (`exactOptionalPropertyTypes`). */
export function optional<T>(key: string, value: T | undefined): Record<string, T> {
  return value === undefined ? {} : { [key]: value };
}

/**
 * Drops `undefined`-valued keys from a zod result, so an absent optional field
 * is truly absent rather than present-and-undefined (`exactOptionalPropertyTypes`).
 */
export function exact<T extends object>(value: { readonly [K in keyof T]: T[K] | undefined }): T {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    const entry = (value as Record<string, unknown>)[key];
    if (entry !== undefined) {
      out[key] = entry;
    }
  }
  return out as T;
}

/**
 * A request's or a level's scripts and the text of each script file (#63, #334). The file read is
 * always the name derived from `stem` (a request's slug, or a level's `api`, `interface` or
 * `folder`), never the one the YAML records. A missing or oversized file is a problem on its owner;
 * an oversized one keeps its text so a save writes it back untouched. `owner` names the owner in a
 * problem's message: `Request "Checkout"`, `Folder "Orders"`.
 */
export async function loadScripts(
  fs: FsLike,
  root: string,
  dir: string,
  stem: string,
  document: z.infer<typeof scriptsSchema> | undefined,
  owner: string,
  problems: ProjectProblem[],
  claim: (fileName: string) => void,
): Promise<RequestScripts | undefined> {
  if (document === undefined) {
    return undefined;
  }
  const read = async (phase: ScriptPhase): Promise<ScriptSource | undefined> => {
    if ((phase === 'pre' ? document.pre : document.post) === undefined) {
      return undefined;
    }
    const name = scriptFileName(stem, phase, document.api);
    claim(name);
    const relative = `${dir}/${name}`;
    const buffer = await readFileIfExists(fs, abs(root, relative));
    if (buffer === undefined) {
      problems.push({
        code: 'script-file-missing',
        message: `${owner} names a ${phase === 'pre' ? 'pre-request' : 'post-response'} script whose file is missing`,
        file: relative,
      });
      return { text: '', problem: 'script-file-missing' };
    }
    const text = buffer.toString('utf8');
    if (buffer.byteLength > SCRIPT_LIMITS.fileBytes) {
      problems.push({
        code: 'script-too-large',
        message: `${owner} has a script over ${String(SCRIPT_LIMITS.fileBytes / 1024)} KiB, which will not run`,
        file: relative,
      });
      return { text, problem: 'script-too-large' };
    }
    return { text };
  };
  const pre = await read('pre');
  const post = await read('post');
  return {
    ...(pre !== undefined ? { pre } : {}),
    ...(post !== undefined ? { post } : {}),
    api: document.api,
    enabled: document.enabled,
    secrets: [...document.secrets],
    ...(document.timeoutMs !== undefined ? { timeoutMs: document.timeoutMs } : {}),
  };
}

/**
 * Authentication as loaded: the same `undefined`-key drop {@link exact} performs, expressed
 * separately because `AuthConfig` is a union and so has no single mapped shape to hand `exact`.
 * The cast is safe for the same reason `exact`'s is: the schema has already established the
 * arm's own fields, and this only removes keys whose value is absent.
 */
export function authConfig(parsed: Record<string, unknown>): AuthConfig {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (value !== undefined) {
      out[key] = value;
    }
  }
  return out as unknown as AuthConfig;
}

/**
 * A definition's fetch credentials as loaded, through {@link authConfig}. `definitionAuthSchema` has
 * already refused every scheme but Basic, Bearer, API key and Kerberos, so the narrowing cast only restates
 * what parsing proved.
 */
export function definitionAuth(parsed: Record<string, unknown> | undefined): DefinitionAuth | undefined {
  return parsed === undefined ? undefined : (authConfig(parsed) as unknown as DefinitionAuth);
}

/** A table row as loaded: `enabled` defaults to true, an absent description stays absent. */
export function keyValueEntries(rows: readonly KeyValueEntryFile[]): KeyValueEntry[] {
  return rows.map((row) =>
    exact<KeyValueEntry>({ name: row.name, value: row.value, enabled: row.enabled, description: row.description }),
  );
}

/** A folder of either protocol's tree: the same node, holding one kind of request. */
export interface FolderNode<R> {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly order: number;
  readonly description?: string;
  readonly auth?: AuthConfig;
  readonly scripts?: RequestScripts;
  readonly folders: readonly FolderNode<R>[];
  readonly requests: readonly R[];
}

/** What one directory of an API's request tree holds. */
export interface FolderContents<R> {
  readonly folders: FolderNode<R>[];
  readonly requests: R[];
}

/** What the tree loader needs of a request of any protocol. */
export interface TreeRequest {
  readonly order: number;
  readonly name: string;
  readonly slug: string;
  readonly scripts?: RequestScripts;
}

/**
 * A scripted folder's requests with the one clash its files can have settled: a request slugged
 * `folder` that has scripts too names the folder's own files, which the folder has claimed. That is
 * a `script-file-clash` problem, and the request's scripts load as missing, so it refuses to send
 * until it is renamed.
 */
function withoutFolderClash<R extends TreeRequest>(
  contents: FolderContents<R>,
  dir: string,
  problems: ProjectProblem[],
): FolderContents<R> {
  const requests = contents.requests.map((request) => {
    const scripts = request.scripts;
    if (request.slug !== FOLDER_SCRIPT_STEM || scripts === undefined) return request;
    const missing: ScriptSource = { text: '', problem: 'script-file-missing' };
    for (const phase of ['pre', 'post'] as const) {
      if (scripts[phase] === undefined) continue;
      problems.push({
        code: 'script-file-clash',
        message: `Request "${request.name}" and its folder both name ${scriptFileName(FOLDER_SCRIPT_STEM, phase, scripts.api)}, which is the folder's; rename the request`,
        file: `${dir}/${scriptFileName(FOLDER_SCRIPT_STEM, phase, scripts.api)}`,
      });
    }
    return {
      ...request,
      scripts: {
        ...scripts,
        ...(scripts.pre !== undefined ? { pre: missing } : {}),
        ...(scripts.post !== undefined ? { post: missing } : {}),
      },
    };
  });
  return { ...contents, requests };
}

/**
 * Reads one `*.request.yaml` of a tree into a request of the API's protocol, claiming the files it
 * owns (its own, and its body file) out of `unclaimed` so they are not reported as orphans.
 */
export type RequestReader<R> = (dir: string, fileName: string, unclaimed: Set<string>) => Promise<R>;

/**
 * Loads one directory of an API's request tree: its `*.request.yaml` files as requests (through
 * the protocol's reader), its subdirectories as folders, recursively.
 *
 * A directory with no `folder.yaml` is still a folder — named after the directory, ordered after
 * the ones that do have a file, and given a file of its own on the next save — because a folder
 * someone created with `mkdir` in a checked-out project is a folder, not a fault. A directory
 * deeper than {@link MAX_FOLDER_DEPTH} becomes a problem and is skipped whole, so nothing is ever
 * written to a path that might not open on Windows. A request's `<slug>.examples/` directory is
 * not a folder ({@link isExamplesDir}): its request's reader reads the files in it.
 *
 * A folder's scripts (#334) are read before its requests, and their files are claimed out of the
 * folder's directory (`claimed`), so the folder owns `folder.pre.ts` even when a request there is
 * slugged `folder` ({@link withoutFolderClash}).
 */
export async function loadFolderContents<R extends TreeRequest>(
  fs: FsLike,
  root: string,
  dir: string,
  depth: number,
  problems: ProjectProblem[],
  readRequest: RequestReader<R>,
  folderExtra?: (document: unknown, relative: string) => Record<string, unknown>,
  claimed: ReadonlySet<string> = new Set(),
): Promise<FolderContents<R>> {
  const entries = await readdirIfExists(fs, abs(root, dir));
  const unclaimed = new Set(
    entries.filter((e) => e.isFile && e.name !== FOLDER_FILE && !claimed.has(e.name)).map((e) => e.name),
  );
  const requestSlugs = new Set(
    entries
      .filter((e) => e.isFile && e.name.endsWith(REQUEST_SUFFIX))
      .map((e) => e.name.slice(0, -REQUEST_SUFFIX.length)),
  );
  const requests: R[] = [];
  const folders: FolderNode<R>[] = [];

  for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isFile && entry.name.endsWith(REQUEST_SUFFIX)) {
      requests.push(await readRequest(dir, entry.name, unclaimed));
      // A request's golden sidecar (#34) belongs to it whatever its protocol.
      unclaimed.delete(`${entry.name.slice(0, -REQUEST_SUFFIX.length)}${GOLDEN_SUFFIX}`);
      continue;
    }
    if (!entry.isDirectory || (await isExamplesDir(fs, root, dir, entry.name, requestSlugs))) {
      continue;
    }
    const childDir = `${dir}/${entry.name}`;
    if (depth + 1 > MAX_FOLDER_DEPTH) {
      problems.push({
        code: 'folder-too-deep',
        message: `Folder "${entry.name}" is nested more than ${String(MAX_FOLDER_DEPTH)} deep and was skipped`,
        file: childDir,
      });
      continue;
    }
    const relative = `${childDir}/${FOLDER_FILE}`;
    const document = await readYaml(fs, root, relative);
    const parsed = document === undefined ? undefined : parseFile(restFolderFileSchema, document, relative);
    const folderName = parsed?.name ?? entry.name;
    const scriptFiles = new Set<string>();
    const scripts = await loadScripts(
      fs,
      root,
      childDir,
      FOLDER_SCRIPT_STEM,
      parsed?.scripts,
      `Folder "${folderName}"`,
      problems,
      (name) => scriptFiles.add(name),
    );
    const loaded = await loadFolderContents(
      fs,
      root,
      childDir,
      depth + 1,
      problems,
      readRequest,
      folderExtra,
      scriptFiles,
    );
    const contents = scripts === undefined ? loaded : withoutFolderClash(loaded, childDir, problems);
    folders.push({
      id: parsed?.id ?? `folder:${entry.name}`,
      name: folderName,
      slug: entry.name,
      order: parsed?.order ?? Number.MAX_SAFE_INTEGER,
      ...optional('description', parsed?.description),
      ...(parsed?.auth !== undefined ? { auth: authConfig(parsed.auth) } : {}),
      ...(scripts !== undefined ? { scripts } : {}),
      folders: contents.folders,
      requests: contents.requests,
      ...(folderExtra?.(document, relative) ?? {}),
    });
  }

  for (const orphan of [...unclaimed].sort()) {
    problems.push({
      code: 'orphan-request-file',
      message: `"${orphan}" does not belong to any request`,
      file: `${dir}/${orphan}`,
    });
  }
  return { folders: folders.sort(byOrder), requests: requests.sort(byOrder) };
}
