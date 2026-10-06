/**
 * `local.yaml`: the machine-local half of a workspace's app-data folder. Never inside the tree,
 * never committed, never shared — it is the one place `activeEnvironmentId` lives now that
 * `workspace.yaml` no longer carries it (see `model.ts`). It also holds this machine's
 * secret-source overrides and its approval of the shared mapping (secret sources spec D1, D4).
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
import type { LocalSecretSources } from '../secrets/sources/parse.js';
import { parseLocalSecretSources, serializeSecretSources } from '../secrets/sources/parse.js';
import { workspaceLocalStateSchema } from './schema.js';

/** File name of a workspace's machine-local state, directly under its app-data folder. */
export const WORKSPACE_LOCAL_FILE = 'local.yaml';

/** What this machine approved of a workspace's shared secret sources: the hash, and the mapping it was taken over. */
export interface SecretSourcesApproval {
  readonly hash: string;
  readonly mapping: Readonly<Record<string, unknown>>;
}

/** The machine-local state of one workspace on this machine. */
export interface WorkspaceLocalState {
  readonly version: 2;
  /** Id of the environment currently active for this workspace, on this machine. */
  readonly activeEnvironmentId?: string;
  /** This machine's secret-source overrides; `{ kind: none }` unmaps a shared name. */
  readonly secretSources?: LocalSecretSources;
  /** The shared mapping this machine approved (secret sources spec D4). */
  readonly secretSourcesApproved?: SecretSourcesApproval;
}

/** The state of a workspace that has never had anything local recorded for it. */
export const EMPTY_LOCAL_STATE: WorkspaceLocalState = { version: 2 };

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
  const data = result.data;
  const local = parseLocalSecretSources(data.secretSources).sources;
  return {
    version: 2,
    ...(data.activeEnvironmentId !== undefined ? { activeEnvironmentId: data.activeEnvironmentId } : {}),
    ...(Object.keys(local).length > 0 ? { secretSources: local } : {}),
    ...(data.secretSourcesApproved !== undefined ? { secretSourcesApproved: data.secretSourcesApproved } : {}),
  };
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
  const empty =
    state.activeEnvironmentId === undefined &&
    (state.secretSources === undefined || Object.keys(state.secretSources).length === 0) &&
    state.secretSourcesApproved === undefined;
  if (empty) {
    await fs.rm(path, { force: true });
    return;
  }
  await writeFileAtomic(
    fs,
    path,
    stringifyYaml(
      compact({
        version: 2,
        activeEnvironmentId: state.activeEnvironmentId,
        secretSources:
          state.secretSources !== undefined && Object.keys(state.secretSources).length > 0
            ? serializeSecretSources(state.secretSources)
            : undefined,
        secretSourcesApproved: state.secretSourcesApproved,
      }),
    ),
  );
}
