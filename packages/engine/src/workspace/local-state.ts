/**
 * `local.yaml`: the machine-local half of a workspace's app-data folder. Never inside the tree,
 * never committed, never shared — it is the one place `activeEnvironmentId` lives now that
 * `workspace.yaml` no longer carries it (see `model.ts`).
 *
 * Mirrors `share.ts`'s discipline (`readYaml`/`parseWorkspaceFile` in, `stringifyYaml` +
 * `writeFileAtomic` out) but never throws on a missing or corrupt file: a machine-local file
 * that cannot be read is simply "no local state yet", not an error the user needs to see.
 */

import { join } from 'node:path';
import { parse as parseYamlDocument } from 'yaml';
import type { FsLike } from '../project/fs.js';
import { nodeFs, readFileIfExists, writeFileAtomic } from '../project/fs.js';
import { stringifyYaml, compact } from '../project/yaml.js';
import { workspaceLocalStateSchema } from './schema.js';

/** File name of a workspace's machine-local state, directly under its app-data folder. */
export const WORKSPACE_LOCAL_FILE = 'local.yaml';

/** The machine-local state of one workspace on this machine. */
export interface WorkspaceLocalState {
  readonly version: 1;
  /** Id of the environment currently active for this workspace, on this machine. */
  readonly activeEnvironmentId?: string;
}

/** The state of a workspace that has never had anything local recorded for it. */
export const EMPTY_LOCAL_STATE: WorkspaceLocalState = { version: 1 };

/** Options shared by {@link loadLocalState} and {@link saveLocalState}. */
export interface LocalStateOptions {
  readonly fs?: FsLike;
}

/**
 * Reads `<dir>/local.yaml`. A missing file, unparseable YAML, or a document that fails
 * {@link workspaceLocalStateSchema} all resolve to {@link EMPTY_LOCAL_STATE} rather than
 * throwing — this file is a cache of machine-local convenience state, not a source of truth
 * worth failing an `open()` over.
 */
export async function loadLocalState(dir: string, options?: LocalStateOptions): Promise<WorkspaceLocalState> {
  const fs = options?.fs ?? nodeFs;
  const buffer = await readFileIfExists(fs, join(dir, WORKSPACE_LOCAL_FILE));
  if (buffer === undefined) {
    return EMPTY_LOCAL_STATE;
  }
  let document: unknown;
  try {
    document = parseYamlDocument(buffer.toString('utf8'));
  } catch {
    return EMPTY_LOCAL_STATE;
  }
  const result = workspaceLocalStateSchema.safeParse(document);
  if (!result.success) {
    return EMPTY_LOCAL_STATE;
  }
  return result.data.activeEnvironmentId === undefined
    ? EMPTY_LOCAL_STATE
    : { version: 1, activeEnvironmentId: result.data.activeEnvironmentId };
}

/**
 * Writes `state` to `<dir>/local.yaml` atomically. When `state` equals {@link EMPTY_LOCAL_STATE}
 * (nothing worth recording), the file is deleted instead of writing an empty document — so a
 * workspace that never sets an active environment never grows a `local.yaml` at all.
 */
export async function saveLocalState(
  dir: string,
  state: WorkspaceLocalState,
  options?: LocalStateOptions,
): Promise<void> {
  const fs = options?.fs ?? nodeFs;
  const path = join(dir, WORKSPACE_LOCAL_FILE);
  if (state.activeEnvironmentId === undefined) {
    await fs.rm(path, { force: true });
    return;
  }
  await writeFileAtomic(fs, path, stringifyYaml(compact({ ...state })));
}
