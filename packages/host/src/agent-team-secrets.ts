/**
 * Team secrets for a send a paired browser tab hands this machine's agent (hosted edition spec §18.5): the
 * desktop resolves one from the values its own approved machine already imported for that workspace, by
 * name, exactly as a desktop send of that project does. The one trust pipeline stays the desktop's.
 *
 * The bundle names the workspace, and the server built the bundle, so nothing it says is taken on trust:
 * - the workspace must be a server workspace on this machine whose server is the pairing's own origin: a
 *   server must never name another server's workspace and read its team secrets;
 * - the project must be one of that workspace's;
 * - the bundle's `team-secrets/` subtree is read only to tell whether this machine's copy is current. A
 *   newer entry there answers `team-secret-stale` rather than sending an old value; a forged one can only
 *   make the send fail, which the server could do anyway.
 *
 * Nothing here attaches to a window, writes the workspace's state or opens a vault entry: the values were
 * imported on pull, and are read from the store by the label a send reads them under.
 */
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  loadWorkspace,
  parseTeamSecretsFile,
  TEAM_SECRETS_DIR,
  vaultEntryFileSchema,
  vaultEntryId,
  vaultEntryPath,
  WirebenchError,
  WORKSPACES_DIR,
  type SecretKey,
  type Workspace,
} from '@wirebench/engine';
import { secretStoreLabel } from './secret-resolver.js';
import type { AgentTeamSecretQuery } from './send/detached.js';
import { TeamSecretsService, type TeamSecretsStore, type TeamSecretsWorkspace } from './team-secrets-service.js';
import { resolveWorkspaceTree } from './workspace-files.js';

export interface AgentTeamSecretsDeps {
  /** The host's userData: its `workspaces/` folder is where this machine's workspaces are. */
  readonly userDataDir: string;
  /** The raw keychain-backed store: the machine keys and the imported values. */
  readonly store: TeamSecretsStore;
  /** This machine's name before its key request gives one; the host name by default. */
  readonly machine?: () => string;
}

/** A server workspace on this machine. */
interface LocalServerWorkspace {
  readonly dir: string;
  readonly tree: string;
  readonly workspace: Workspace;
}

function originOf(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

/** The server workspace `workspaceId` this machine holds from the server at `origin`, if any. */
async function serverWorkspace(
  userDataDir: string,
  workspaceId: string,
  origin: string,
): Promise<LocalServerWorkspace | undefined> {
  const root = join(userDataDir, WORKSPACES_DIR);
  let names: string[];
  try {
    names = (await readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((e) => e.name);
  } catch {
    return undefined;
  }
  for (const name of names) {
    const dir = join(root, name);
    try {
      const { share, tree } = await resolveWorkspaceTree(dir);
      const server = share?.kind === 'server' ? share.server : undefined;
      if (server?.workspaceId !== workspaceId || originOf(server.url) !== origin) continue;
      const { workspace } = await loadWorkspace(tree);
      return { dir, tree, workspace };
    } catch {
      // An unreadable workspace is not the one asked for.
    }
  }
  return undefined;
}

/** The workspace as team secrets reads it: no window, no sync, nothing written. */
function readOnlyWorkspace(local: LocalServerWorkspace): TeamSecretsWorkspace {
  return {
    workspaceId: local.workspace.id,
    dir: local.dir,
    tree: local.tree,
    kind: 'server',
    role: () => undefined,
    uses: () => [],
    identity: () => Promise.resolve(undefined),
    beforeWrite: () => undefined,
    afterWrite: () => undefined,
  };
}

/** The `updatedAt` of the bundle's copy of a vault entry, or `undefined` when it has none (or it does not parse). */
function bundleUpdatedAt(files: ReadonlyMap<string, string>, secret: SecretKey): string | undefined {
  const path = vaultEntryPath(vaultEntryId(secret)).slice(`${TEAM_SECRETS_DIR}/`.length);
  const text = files.get(path);
  return text === undefined ? undefined : parseTeamSecretsFile(vaultEntryFileSchema, text)?.updatedAt;
}

function needsApproval(message: string, details: Record<string, unknown>): WirebenchError {
  return new WirebenchError('team-secret-needs-approval', message, { details });
}

function stale(name: string, workspace: Workspace): WirebenchError {
  return new WirebenchError(
    'team-secret-stale',
    `This machine’s copy of the team secret ${name} is older than the server’s. Open ${workspace.name} in the Wirebench desktop app on this machine and sync it, then send again.`,
    { details: { workspaceId: workspace.id, name } },
  );
}

/**
 * The team-secrets hook of the host's detached sends (`DetachedSendDeps.teamSecrets`). It answers a value,
 * `undefined` for a name that is not one of the workspace's team secrets (the send then fails
 * `secret-missing`), or throws `team-secret-needs-approval` or `team-secret-stale` with what to do.
 */
export function agentTeamSecrets(
  deps: AgentTeamSecretsDeps,
): (query: AgentTeamSecretQuery) => Promise<string | undefined> {
  return async (query) => {
    const { projectId, name } = query;
    if (projectId === undefined) return undefined;
    const local = await serverWorkspace(deps.userDataDir, query.workspaceId, query.serverOrigin);
    if (local === undefined) {
      throw needsApproval(
        `This request reads a team secret of a workspace this machine has not opened. Open the workspace from ${query.serverOrigin} in the Wirebench desktop app on this machine, then send again.`,
        { workspaceId: query.workspaceId },
      );
    }
    const { workspace } = local;
    if (!workspace.projects.some((ref) => ref.id === projectId)) return undefined;
    const secret: SecretKey = { token: { projectId, name } };
    // A service of its own, never attached: a window's, if one has the workspace open, is left alone.
    const service = new TeamSecretsService({ store: deps.store, ...(deps.machine ? { machine: deps.machine } : {}) });
    const lookup = await service.agentLookup(readOnlyWorkspace(local), secret);
    const serverAt = bundleUpdatedAt(query.bundleTeamSecrets, secret);
    if (!lookup.inVault && serverAt === undefined) return undefined;
    if (lookup.on && lookup.state !== 'approved') {
      throw needsApproval(
        `This machine (${lookup.machine}) is not approved for the team secrets of ${workspace.name}. Ask an admin of the workspace to approve ${lookup.machine}, then send again.`,
        { workspaceId: workspace.id, machine: lookup.machine },
      );
    }
    // Not imported yet, imported before the server's copy changed, or gone from the server since.
    if (!lookup.on || !lookup.inVault || serverAt === undefined || lookup.acceptedAt === undefined) {
      throw stale(name, workspace);
    }
    if (Date.parse(serverAt) > Date.parse(lookup.acceptedAt)) throw stale(name, workspace);
    if (!lookup.trusted) return undefined;
    const ref = await deps.store.findByLabel(secretStoreLabel(projectId, name));
    return ref === undefined ? undefined : await deps.store.get(ref);
  };
}
