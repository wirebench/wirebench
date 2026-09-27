/**
 * Team secrets in a shared workspace (docs/specs/2026-09-26-team-secrets-design.md), in main.
 *
 * Owns this machine's key per workspace, kept in the keychain-backed store under
 * `wirebench-team-key:<workspaceId>`, and reads and writes the tree's `team-secrets/` files through the
 * workspace it is attached to. Values and private keys go only into the `SecretStore` and, encrypted,
 * into the tree: every answer is ids, names, fingerprints and labels.
 *
 * One operation at a time (a promise chain). Nothing here awaits the sync queue: the pull hook runs
 * inside a queued sync operation, so commits and server requests are fired, not awaited (plan decision 14).
 */
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { hostname, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import {
  accessEntryPath,
  approvedRecipients,
  buildVaultEntry,
  fingerprintOf,
  generateMachineKeys,
  GIT_ATTRIBUTES,
  GIT_ATTRIBUTES_FILE,
  healVaultEntry,
  isTeamSecretsPath,
  isVaultEntryPath,
  keyRequestPath,
  nextAccessEntryId,
  openVaultEntry,
  parseMachineKeys,
  parseSecretPseudoRef,
  parseTeamSecretsFile,
  readTeamSecretsFiles,
  replayAccessLog,
  rotateMarksFor,
  sealVaultEntry,
  secretKeySchema,
  serializeMachineKeys,
  signDocument,
  TEAM_SECRETS_DIR,
  TEAM_SECRETS_MESSAGES,
  teamSecretsError,
  teamSecretsFileText,
  vaultConflictWinner,
  vaultEntryFileSchema,
  vaultEntryId,
  vaultEntryIdOfPath,
  vaultEntryPath,
  verifiedKeys,
  verifyVaultEntry,
  wrapsUnapprovedKey,
  type AccessAction,
  type AccessEntryFile,
  type AccessState,
  type KeyInfo,
  type LogProblem,
  type MachineKeys,
  type SecretKey,
  type TeamSecretsFiles,
  type VaultEntryFile,
} from '@wirebench/engine';
import type { SyncConflictWire, TeamSecretsKeyWire, TeamSecretsStatusWire } from '../shared/wire-types.js';
import { secretStoreLabel } from './secret-resolver.js';
import {
  isMachineOnlyLabel,
  newSecretRef,
  TEAM_KEY_LABEL_PREFIX,
  TEAM_REPLACED_LABEL_PREFIX,
  type SecretStore,
} from './secrets.js';
import type { ConflictSides } from './sync/backend.js';

/** The machine-only store labels; defined beside the store, which fences them off from secret values. */
export { TEAM_KEY_LABEL_PREFIX, TEAM_REPLACED_LABEL_PREFIX } from './secrets.js';
/** Machine-local, in the workspace's app-data folder: the genesis pin, seen entries, replaced notices. */
export const TEAM_SECRETS_LOCAL_FILE = 'team-secrets.json';

const ATTRIBUTES_LINE = 'team-secrets/values/** -merge';
/** The store label a `${secret:name}` token's value is kept under; a vault ref entry may never claim it. */
const TOKEN_LABEL_PREFIX = 'wirebench-secret:';

export const TEAM_SECRETS_OFF: TeamSecretsStatusWire = {
  on: false,
  canTurnOn: false,
  canManage: false,
  me: { state: 'none', admin: false },
  pending: [],
  approved: [],
  formerMembers: [],
  rotate: [],
  untrusted: [],
  replaced: [],
  localOnly: [],
};

export type TeamSecretsStore = Pick<
  SecretStore,
  | 'get'
  | 'getMachineOnly'
  | 'set'
  | 'put'
  | 'putMachineOnly'
  | 'delete'
  | 'findByLabel'
  | 'list'
  | 'encryptionAvailable'
>;

/** One secret the workspace's projects use. */
export interface SecretUse {
  readonly secret: SecretKey;
}

/** What the service needs from the open shared workspace; `WorkspaceService` builds it (Task 9). */
export interface TeamSecretsWorkspace {
  readonly workspaceId: string;
  /** The workspace's app-data folder, never the tree. */
  readonly dir: string;
  readonly tree: string;
  readonly kind: 'git' | 'folder' | 'server';
  /** The server role; `undefined` for git and folder shares, and before the first fetch. */
  readonly role: () => 'viewer' | 'editor' | 'admin' | undefined;
  readonly uses: () => readonly SecretUse[];
  readonly identity: () => Promise<{ readonly name: string; readonly email: string } | undefined>;
  /** Tree paths about to be written or removed: the watcher's self-writes. */
  readonly beforeWrite: (paths: readonly string[]) => void;
  /** Files were written: commit (and push) under `message`, as a save would. Never awaited. */
  readonly afterWrite: (message: string) => void;
  /** Server shares: sends a key request through the route (§5.1). */
  readonly requestKey?: (keyId: string, content: string) => Promise<void>;
  /** Server shares: the emails with a role now; `undefined` when this account may not ask. */
  readonly memberEmails?: () => Promise<readonly string[] | undefined>;
}

export interface TeamSecretsServiceDeps {
  /** The raw keychain-backed store: never the team-aware wrapper, which would write the vault again. */
  readonly store: TeamSecretsStore;
  readonly onChanged?: (workspaceId: string, status: TeamSecretsStatusWire) => void;
  readonly now?: () => Date;
  /** The machine label on a key request; the host name by default. */
  readonly machine?: () => string;
  /** The name on a folder share's key request, which has no commit identity (plan decision 21). */
  readonly osUser?: () => string;
  /** Messages only: never a value. */
  readonly log?: (message: string) => void;
}

const localStateSchema = z.object({
  version: z.literal(1),
  genesisId: z.string().optional(),
  seenAccess: z.array(z.string()).default([]),
  /**
   * This machine's key once its request was seen in the tree. Seen, then gone while neither approved nor
   * removed, means an admin declined it: no automatic request again (§3.2).
   */
  seenKeyId: z.string().optional(),
  /** Every removal replayed so far, so its rotate marks outlive the removed key's request file (§3.6). */
  seenRemovals: z.array(z.object({ keyId: z.string(), name: z.string(), at: z.string() })).default([]),
  /**
   * Rollback protection: per vault id, the latest `updatedAt` this machine accepted after a pull. A trusted
   * entry dated earlier is an older signed copy put back, and is refused.
   */
  accepted: z.record(z.string(), z.string()).default({}),
  replaced: z
    .array(
      z.object({
        entryId: z.string(),
        label: z.string(),
        byName: z.string(),
        secret: secretKeySchema,
        /** The store ref the losing value is kept under, on this machine only. */
        storedRef: z.string(),
      }),
    )
    .default([]),
});
type LocalState = z.infer<typeof localStateSchema>;

interface View {
  readonly ws: TeamSecretsWorkspace;
  readonly files: TeamSecretsFiles;
  readonly access: AccessState;
  readonly me: MachineKeys | undefined;
  readonly local: LocalState;
  /** A remembered access entry is missing from the tree, or now fails its signature or signer (plan decision 4). */
  readonly damaged: boolean;
  /**
   * Vault entries the replay trusts that are still refused: an older copy than this machine accepted
   * (`rolled-back`), or one labelled like a machine-only store entry (`machine-label`).
   */
  readonly refused: ReadonlyMap<string, Refusal>;
}

type Refusal = 'rolled-back' | 'machine-label';

/**
 * Whether a vault entry's label is one no shared value may carry: a machine-only store label, or (on a ref
 * entry) a token's store label, which would shadow that project's `${secret:name}` value.
 */
function forbiddenLabel(entry: Pick<VaultEntryFile, 'label' | 'secret'>): boolean {
  return isMachineOnlyLabel(entry.label) || ('ref' in entry.secret && entry.label.startsWith(TOKEN_LABEL_PREFIX));
}

type MyState = TeamSecretsStatusWire['me']['state'];

/** What the send path reads synchronously (Task 7). */
interface SendCache {
  readonly on: boolean;
  readonly state: MyState;
  readonly vaultIds: ReadonlySet<string>;
}

/** The cache with no workspace, or before the first load. */
function offCache(): SendCache {
  return { on: false, state: 'none', vaultIds: new Set() };
}

async function readTreeFiles(tree: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  for (const kind of ['keys', 'access', 'values']) {
    const dir = join(tree, TEAM_SECRETS_DIR, kind);
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      const path = `${TEAM_SECRETS_DIR}/${kind}/${name}`;
      if (!isTeamSecretsPath(path)) {
        continue;
      }
      try {
        files.set(path, await readFile(join(dir, name), 'utf8'));
      } catch {
        // Gone since the listing: a pull or an outside edit moved it.
      }
    }
  }
  return files;
}

async function readLocalState(dir: string): Promise<LocalState> {
  try {
    return localStateSchema.parse(JSON.parse(await readFile(join(dir, TEAM_SECRETS_LOCAL_FILE), 'utf8')));
  } catch {
    return { version: 1, seenAccess: [], seenRemovals: [], accepted: {}, replaced: [] };
  }
}

async function writeLocalState(dir: string, state: LocalState): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, TEAM_SECRETS_LOCAL_FILE), JSON.stringify(state, null, 2), 'utf8');
}

/**
 * Plan decision 4: the replay problems that mean a seen entry was tampered with (its signature, or its
 * signer's key request, no longer checks out). Any other problem on a seen entry (a concurrent change
 * reordered who could make it) only stops it counting.
 */
const TAMPER_PROBLEMS: ReadonlySet<LogProblem> = new Set<LogProblem>(['bad-signature', 'unknown-signer']);

/**
 * Whether a seen entry's problem means tampering. A subject's request gone (`unknown-key`) is tamper too,
 * except on an `approve`: only a pending key can be declined, and a concurrent decline removes exactly that
 * request. A removal's or an admin change's subject was approved, so its request is never declined.
 */
function isTamper(problem: LogProblem, action: AccessAction | undefined): boolean {
  return TAMPER_PROBLEMS.has(problem) || (problem === 'unknown-key' && action !== 'approve');
}

/** The error for an access entry the replay would reject (generic guard before writing). */
function refusal(problem: LogProblem): Error {
  switch (problem) {
    case 'already-admin':
      return teamSecretsError('team-secrets-already-admin');
    case 'not-admin':
      return teamSecretsError('team-secrets-not-admin');
    case 'last-admin':
      return teamSecretsError('team-secrets-last-admin');
    case 'last-approved':
      return teamSecretsError('team-secrets-last-approved');
    default:
      return teamSecretsError('team-secrets-not-allowed');
  }
}

/** The error a send, or an access change, meets on a machine that may not take part (§3.8). */
function notApprovedError(state: MyState): Error {
  return teamSecretsError(
    state === 'removed'
      ? 'team-secrets-removed'
      : state === 'declined'
        ? 'team-secrets-declined'
        : 'team-secrets-pending',
  );
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sameList(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  return a !== undefined && b !== undefined && a.length === b.length && a.every((item, i) => item === b[i]);
}

export class TeamSecretsService {
  private ws: TeamSecretsWorkspace | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  /** What the send path reads synchronously (Task 7): refreshed by every load. */
  protected cache: SendCache = offCache();
  private members: readonly string[] | undefined;
  private readonly now: () => Date;

  constructor(private readonly deps: TeamSecretsServiceDeps) {
    this.now = deps.now ?? ((): Date => new Date());
  }

  /** The open shared workspace; `WorkspaceService` calls it on open, before sync starts. */
  attach(ws: TeamSecretsWorkspace): void {
    this.ws = ws;
    this.members = undefined;
    this.cache = offCache();
  }

  /** The workspace closed: nothing further touches its tree, and the operation in flight finishes. */
  async detach(): Promise<void> {
    this.ws = undefined;
    this.cache = offCache();
    await this.queue.catch(() => undefined);
  }

  status(): Promise<TeamSecretsStatusWire> {
    return this.enqueue(async () => {
      const ws = this.ws;
      return ws === undefined ? TEAM_SECRETS_OFF : await this.statusOf(await this.load(ws));
    });
  }

  /** §3.1: genesis, this machine's key and every value it holds; `commit: false` inside the share's own first commit. */
  turnOn(options: { readonly commit: boolean } = { commit: true }): Promise<TeamSecretsStatusWire> {
    return this.enqueue(async () => {
      const ws = this.requireWorkspace();
      await this.turnOnNow(ws, options.commit);
      return await this.emit(ws);
    });
  }

  /** Plan decision 10: a server share turns on after its first push, when the sharer turns out to be an admin. */
  turnOnIfAdmin(): Promise<void> {
    return this.enqueue(async () => {
      const ws = this.ws;
      if (ws?.kind !== 'server' || ws.role() !== 'admin' || (await this.load(ws)).access.on) {
        return;
      }
      await this.turnOnNow(ws, true);
      await this.emit(ws);
    });
  }

  /** After every pull, and a folder share's outside edit under `team-secrets/`. Never throws. */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- every pull re-reads the whole vault
  afterPull(_paths: readonly string[]): Promise<void> {
    return this.enqueue(async () => {
      const ws = this.ws;
      if (ws === undefined) {
        return;
      }
      try {
        await this.refreshNow(ws);
      } catch (error) {
        this.deps.log?.(`[team-secrets] refresh failed: ${describeError(error)}`);
      }
      // Still inside the guard: the status a failed refresh leaves is shown too, and nothing escapes.
      try {
        await this.emit(ws);
      } catch (error) {
        this.deps.log?.(`[team-secrets] status failed: ${describeError(error)}`);
      }
    });
  }

  /** §3.2: an `approve` entry and every vault entry this machine can open healed for the new key, in one commit. */
  approve(keyId: string): Promise<TeamSecretsStatusWire> {
    return this.enqueue(async () => {
      const { view, me } = await this.managerView();
      const subject = this.pendingKey(view, keyId);
      const entry = this.accessEntry(view, 'approve', keyId, me);
      const next = this.replayOrRefuse(view, entry);
      const files = new Map<string, string | null>([[accessEntryPath(entry.id), teamSecretsFileText(entry)]]);
      for (const [id, value] of this.trustedValues(view)) {
        const healed = healVaultEntry(value, next, me);
        if (healed !== undefined) {
          files.set(vaultEntryPath(id), teamSecretsFileText(healed));
        }
      }
      await this.write(view.ws, files);
      view.ws.afterWrite(`Approve team secrets access for ${subject.name}`);
      return await this.emit(view.ws);
    });
  }

  /** §3.2: deletes the request file. */
  decline(keyId: string): Promise<TeamSecretsStatusWire> {
    return this.enqueue(async () => {
      const { view } = await this.managerView();
      const subject = this.pendingKey(view, keyId);
      await this.write(view.ws, new Map([[keyRequestPath(keyId), null]]));
      view.ws.afterWrite(`Decline team secrets access for ${subject.name}`);
      return await this.emit(view.ws);
    });
  }

  /** §3.6: a `remove` entry and every value it can open sealed again for the remaining keys, in one commit. */
  remove(keyId: string): Promise<TeamSecretsStatusWire> {
    return this.enqueue(async () => {
      const { view, me } = await this.managerView();
      const subject = this.approvedKey(view, keyId);
      const entry = this.accessEntry(view, 'remove', keyId, me);
      const recipients = approvedRecipients(this.replayOrRefuse(view, entry));
      if (keyId === me.keyId) {
        throw teamSecretsError('team-secrets-remove-self');
      }
      const files = new Map<string, string | null>([[accessEntryPath(entry.id), teamSecretsFileText(entry)]]);
      const unreadable: string[] = [];
      // Refused entries (an older copy put back, a machine-only label) are skipped on purpose: the removed
      // key already had that ciphertext, and the trusted copy, where machines still hold it, is sealed
      // again by their late re-encryption after the next pull (plan decision 6).
      for (const [id, value] of this.trustedValues(view)) {
        const plain = openVaultEntry(value, me);
        if (plain === undefined) {
          unreadable.push(value.label);
        } else {
          files.set(vaultEntryPath(id), teamSecretsFileText(sealVaultEntry(value, plain, recipients, me)));
        }
      }
      if (unreadable.length > 0) {
        // Sealing only what it can read would leave the removed key's wraps on the rest.
        throw teamSecretsError('team-secrets-cannot-reencrypt', { labels: unreadable });
      }
      await this.write(view.ws, files);
      view.ws.afterWrite(`Remove ${subject.name} from team secrets`);
      return await this.emit(view.ws);
    });
  }

  grantAdmin(keyId: string): Promise<TeamSecretsStatusWire> {
    return this.changeAdmin(keyId, 'grant-admin');
  }

  revokeAdmin(keyId: string): Promise<TeamSecretsStatusWire> {
    return this.changeAdmin(keyId, 'revoke-admin');
  }

  /**
   * Plan decision 20: a removed or declined machine makes a fresh key and asks again. A request that fails
   * (the server's rate limit, no network) throws, and this machine keeps the key it had, so the status never
   * claims a request that was not made.
   */
  requestAccess(): Promise<TeamSecretsStatusWire> {
    return this.enqueue(async () => {
      const ws = this.requireWorkspace();
      const view = await this.load(ws);
      if (!view.access.on || this.myState(view) === 'approved') {
        return await this.statusOf(view);
      }
      const label = this.keyLabel(ws);
      const oldRef = await this.deps.store.findByLabel(label);
      const old = oldRef === undefined ? undefined : await this.deps.store.getMachineOnly(oldRef);
      try {
        await this.sendKeyRequest(ws, await this.newKeys(ws), { wait: true });
      } catch (error) {
        const ref = await this.deps.store.findByLabel(label);
        if (old !== undefined && oldRef !== undefined) {
          await this.deps.store.putMachineOnly(oldRef, old, { label });
        } else if (ref !== undefined) {
          await this.deps.store.delete(ref);
        }
        throw error;
      }
      return await this.emit(ws);
    });
  }

  /**
   * §3.1: seals the values the workspace now uses that the vault lacks (a secret a save just started using).
   * After a project or workspace save; the next pull does the same.
   */
  backfill(): Promise<void> {
    return this.enqueue(async () => {
      const ws = this.ws;
      if (ws === undefined) {
        return;
      }
      const files = await this.backfillFiles(await this.load(ws));
      if (files.size === 0) {
        return;
      }
      await this.write(ws, files);
      ws.afterWrite('Update team secrets');
      await this.emit(ws);
    });
  }

  /**
   * §3.3: the value a save stored on this machine, into the vault for every approved key. Only a secret the
   * open workspace uses: an app-level one (the proxy password) stays on this machine. A ref a project starts
   * using later is sealed by the backfill after that save.
   */
  recordValue(secret: SecretKey, label: string, value: string): Promise<void> {
    return this.enqueue(async () => {
      const ws = this.attached;
      if (ws === undefined || !this.isUsed(ws, secret)) {
        return;
      }
      const view = await this.load(ws);
      if (!this.canWriteVault(view) || view.me === undefined) {
        if (view.access.on) {
          await this.emit(ws); // the "Only on this machine" mark (plan decision 17)
        }
        return;
      }
      const id = vaultEntryId(secret);
      // Only a trusted entry with the same label and value is really a no-op; an untrusted one that
      // happens to match (an unapproved or rejected signer, a stale verdict) still needs re-sealing
      // under this machine's own key so the rest of the workspace trusts it again.
      const existing = this.trustedValues(view).get(id);
      if (existing !== undefined && existing.label === label && openVaultEntry(existing, view.me) === value) {
        return;
      }
      const entry = buildVaultEntry({
        secret,
        label,
        value,
        recipients: approvedRecipients(view.access),
        signer: view.me,
        at: this.nextUpdatedAt(view, id),
      });
      await this.write(ws, new Map([[vaultEntryPath(id), teamSecretsFileText(entry)]]));
      ws.afterWrite(`Update secret ${label}`);
      await this.emit(ws);
    });
  }

  /** Plan decision 18: a value deleted on an approved machine leaves the vault too (a secret the workspace uses). */
  forget(secret: SecretKey, label: string): Promise<void> {
    return this.enqueue(async () => {
      const ws = this.attached;
      if (ws === undefined || !this.isUsed(ws, secret)) {
        return;
      }
      const view = await this.load(ws);
      const id = vaultEntryId(secret);
      if (!this.canWriteVault(view) || !view.files.values.has(id)) {
        return;
      }
      await this.write(ws, new Map([[vaultEntryPath(id), null]]));
      ws.afterWrite(`Delete secret ${label}`);
      await this.emit(ws);
    });
  }

  /**
   * §3.2, §3.8: the error for a send that found no value the vault holds for someone else — this machine is
   * waiting for approval, was removed, or was declined — or `undefined`. Reads the state the last load
   * cached, so the send path never waits on the tree.
   */
  missingValueError(ref: string, projectId: string | undefined): Error | undefined {
    if (!this.cache.on || this.cache.state === 'approved') {
      return undefined;
    }
    const name = parseSecretPseudoRef(ref);
    if (name !== undefined && projectId === undefined) {
      return undefined;
    }
    const secret: SecretKey = name === undefined ? { ref } : { token: { projectId: projectId!, name } };
    return this.cache.vaultIds.has(vaultEntryId(secret)) ? notApprovedError(this.cache.state) : undefined;
  }

  /**
   * §3.4, plan decisions 7–9: decides every conflicted vault entry (`team-secrets/values/`) — the newer value
   * wins, a deleted, unreadable or untrusted side loses — and leaves every other path, the key requests and
   * the access log included, to the Conflicts list. Runs inside the sync operation, so it never waits on the
   * sync queue.
   */
  resolveConflicts(
    conflicts: readonly SyncConflictWire[],
    sides: (path: string) => Promise<ConflictSides>,
  ): Promise<Map<string, 'mine' | 'theirs'>> {
    return this.enqueue(async () => {
      const decided = new Map<string, 'mine' | 'theirs'>();
      const ws = this.attached;
      const paths = conflicts.map((conflict) => conflict.path).filter(isVaultEntryPath);
      if (ws === undefined || paths.length === 0) {
        return decided;
      }
      // Mid-merge, the tree may hold access entries the merge could still abort: remember none of them.
      const view = await this.load(ws, { remember: false });
      if (!view.access.on || view.damaged) {
        return decided;
      }
      let local = view.local;
      for (const path of paths) {
        const entryId = vaultEntryIdOfPath(path)!;
        const both = await sides(path).catch(() => undefined);
        if (both === undefined) {
          continue;
        }
        // A side the current log does not trust never wins, however new it claims to be; nor does one older
        // than the value this machine last accepted for the id (a rollback, as `load` refuses it).
        const accepted = view.local.accepted[entryId];
        const usable = (text: string | null): VaultEntryFile | undefined => {
          const entry = text === null ? undefined : parseTeamSecretsFile(vaultEntryFileSchema, text);
          return entry !== undefined &&
            verifyVaultEntry(entry, entryId, view.access) === 'trusted' &&
            !forbiddenLabel(entry) &&
            (accepted === undefined || Date.parse(entry.updatedAt) >= Date.parse(accepted))
            ? entry
            : undefined;
        };
        const mine = usable(both.mine);
        const theirs = usable(both.theirs);
        if (mine === undefined && theirs === undefined) {
          continue;
        }
        const side = vaultConflictWinner(mine, theirs);
        decided.set(path, side);
        if (side !== 'theirs' || mine === undefined || theirs === undefined || view.me === undefined) {
          continue;
        }
        const lost = openVaultEntry(mine, view.me);
        if (lost === undefined || lost === openVaultEntry(theirs, view.me)) {
          continue;
        }
        for (const old of local.replaced.filter((notice) => notice.entryId === entryId)) {
          await this.deps.store.delete(old.storedRef);
        }
        const storedRef = newSecretRef();
        await this.deps.store.putMachineOnly(storedRef, lost, { label: `${TEAM_REPLACED_LABEL_PREFIX}${entryId}` });
        local = {
          ...local,
          replaced: [
            ...local.replaced.filter((notice) => notice.entryId !== entryId),
            {
              entryId,
              label: mine.label,
              byName: view.access.keys.get(theirs.updatedBy)?.name ?? 'Someone',
              secret: mine.secret,
              storedRef,
            },
          ],
        };
      }
      if (local !== view.local) {
        // Only the notices: the seen entries and accepted times on disk stay as they were before the merge.
        await this.saveLocal(ws, { ...(await readLocalState(ws.dir)), replaced: local.replaced });
      }
      return decided;
    });
  }

  /** Puts this machine's replaced value back, here and (when it may write) in the vault as the newest. */
  restoreMine(entryId: string): Promise<TeamSecretsStatusWire> {
    return this.settleReplaced(entryId, true);
  }

  /** Keeps the value that won and forgets this machine's replaced one. */
  dismissReplaced(entryId: string): Promise<TeamSecretsStatusWire> {
    return this.settleReplaced(entryId, false);
  }

  private settleReplaced(entryId: string, restore: boolean): Promise<TeamSecretsStatusWire> {
    return this.enqueue(async () => {
      const ws = this.requireWorkspace();
      const view = await this.load(ws);
      const notice = view.local.replaced.find((item) => item.entryId === entryId);
      if (notice === undefined) {
        return await this.statusOf(view);
      }
      const value = restore ? await this.deps.store.getMachineOnly(notice.storedRef) : undefined;
      if (value !== undefined) {
        await this.importValue(notice.secret, notice.label, value);
        if (!this.canWriteVault(view) || view.me === undefined) {
          // Restored here only: the notice (and the kept value) stay until the vault can take it too.
          return await this.emit(ws);
        }
        const entry = buildVaultEntry({
          secret: notice.secret,
          label: notice.label,
          value,
          recipients: approvedRecipients(view.access),
          signer: view.me,
          at: this.nextUpdatedAt(view, entryId),
        });
        await this.write(ws, new Map([[vaultEntryPath(entryId), teamSecretsFileText(entry)]]));
        ws.afterWrite(`Update secret ${notice.label}`);
      }
      await this.deps.store.delete(notice.storedRef);
      await this.saveLocal(ws, {
        ...view.local,
        replaced: view.local.replaced.filter((item) => item.entryId !== entryId),
      });
      return await this.emit(ws);
    });
  }

  // ——— internals ——————————————————————————————————————————————————————————————————————————

  protected enqueue<T>(op: () => Promise<T>): Promise<T> {
    const result = this.queue.then(op);
    this.queue = result.catch(() => undefined);
    return result;
  }

  protected requireWorkspace(): TeamSecretsWorkspace {
    if (this.ws === undefined) {
      throw teamSecretsError('team-secrets-not-shared');
    }
    return this.ws;
  }

  protected get attached(): TeamSecretsWorkspace | undefined {
    return this.ws;
  }

  protected get store(): TeamSecretsStore {
    return this.deps.store;
  }

  protected get clock(): () => Date {
    return this.now;
  }

  /** Whether the open workspace's projects or environments name `secret` (C1: nothing else reaches the vault). */
  private isUsed(ws: TeamSecretsWorkspace, secret: SecretKey): boolean {
    const id = vaultEntryId(secret);
    return ws.uses().some((use) => vaultEntryId(use.secret) === id);
  }

  private keyLabel(ws: TeamSecretsWorkspace): string {
    return `${TEAM_KEY_LABEL_PREFIX}${ws.workspaceId}`;
  }

  private async myKeys(ws: TeamSecretsWorkspace): Promise<MachineKeys | undefined> {
    const ref = await this.deps.store.findByLabel(this.keyLabel(ws));
    const text = ref === undefined ? undefined : await this.deps.store.getMachineOnly(ref);
    return text === undefined ? undefined : parseMachineKeys(text);
  }

  /** A fresh key pair for this workspace, replacing any older one. @throws team-secrets-no-safe-storage */
  private async newKeys(ws: TeamSecretsWorkspace): Promise<MachineKeys> {
    if (!this.deps.store.encryptionAvailable()) {
      throw teamSecretsError('team-secrets-no-safe-storage');
    }
    const keys = generateMachineKeys();
    const label = this.keyLabel(ws);
    const existing = await this.deps.store.findByLabel(label);
    await this.deps.store.putMachineOnly(existing ?? newSecretRef(), serializeMachineKeys(keys), { label });
    return keys;
  }

  /**
   * Reads the tree and replays the log, pinning the genesis and every valid entry seen (plan decision 4).
   * `remember: false` pins nothing on disk (the view still counts them), for a read mid-merge.
   */
  protected async load(ws: TeamSecretsWorkspace, options: { readonly remember?: boolean } = {}): Promise<View> {
    const files = readTeamSecretsFiles(await readTreeFiles(ws.tree));
    let local = await readLocalState(ws.dir);
    const access = replayAccessLog(
      verifiedKeys(files.keys),
      files.access,
      local.genesisId !== undefined ? { genesisId: local.genesisId } : {},
    );
    const actions = new Map(files.access.map((entry) => [entry.id, entry.action]));
    const problems = new Map(access.problems.map(({ id, problem }) => [id, problem]));
    const damaged = local.seenAccess.some((id) => {
      const problem = problems.get(id);
      return !actions.has(id) || (problem !== undefined && isTamper(problem, actions.get(id)));
    });
    const me = await this.myKeys(ws);
    let next = local;
    if (access.on && !damaged) {
      const seen = [...new Set([...local.seenAccess, ...[...actions.keys()].filter((id) => !problems.has(id))])].sort();
      const removals = [...local.seenRemovals];
      for (const removal of access.removed) {
        if (!removals.some((known) => known.keyId === removal.keyId)) {
          const name = access.keys.get(removal.keyId)?.name ?? removal.keyId;
          removals.push({ keyId: removal.keyId, name, at: removal.at });
        }
      }
      if (
        local.genesisId !== access.genesisId ||
        !sameList(seen, local.seenAccess) ||
        removals.length !== local.seenRemovals.length
      ) {
        next = {
          ...next,
          ...(access.genesisId !== undefined ? { genesisId: access.genesisId } : {}),
          seenAccess: seen,
          seenRemovals: removals,
        };
      }
    }
    if (me !== undefined && access.keys.has(me.keyId) && local.seenKeyId !== me.keyId) {
      next = { ...next, seenKeyId: me.keyId };
    }
    if (next !== local) {
      local = next;
      if (options.remember !== false) {
        await writeLocalState(ws.dir, local);
      }
    }
    const refused = new Map<string, Refusal>();
    for (const [id, entry] of files.values) {
      if (verifyVaultEntry(entry, id, access) !== 'trusted') {
        continue;
      }
      const accepted = local.accepted[id];
      if (forbiddenLabel(entry)) {
        refused.set(id, 'machine-label');
      } else if (accepted !== undefined && Date.parse(entry.updatedAt) < Date.parse(accepted)) {
        refused.set(id, 'rolled-back');
      }
    }
    const view: View = { ws, files, access, me, local, damaged, refused };
    if (ws === this.ws) {
      // A load for a workspace closed meanwhile must not stand in for the open one's.
      this.cache = { on: access.on, state: this.myState(view), vaultIds: new Set(files.values.keys()) };
    }
    return view;
  }

  protected async saveLocal(ws: TeamSecretsWorkspace, local: LocalState): Promise<void> {
    await writeLocalState(ws.dir, local);
  }

  protected myState(view: View): MyState {
    const { me, access } = view;
    if (me === undefined) {
      return this.deps.store.encryptionAvailable() ? 'none' : 'unavailable';
    }
    if (access.approved.has(me.keyId)) {
      return 'approved';
    }
    if (access.removed.some((removal) => removal.keyId === me.keyId)) {
      return 'removed';
    }
    // An approval of this key that this machine saw is still in the tree: its request file went missing after
    // the approval, not by a decline. Waiting again re-sends the same key, and the approve replays valid.
    const seen = new Set(view.local.seenAccess);
    if (view.files.access.some((entry) => entry.action === 'approve' && entry.key === me.keyId && seen.has(entry.id))) {
      return 'pending';
    }
    // Seen in the tree once, and gone since while still waiting: an admin deleted the request (§3.2).
    return view.local.seenKeyId === me.keyId && !access.keys.has(me.keyId) ? 'declined' : 'pending';
  }

  /** Plan decisions 4, 13: approved, not a server viewer, and the log intact. */
  protected canWriteVault(view: View): boolean {
    return (
      view.access.on &&
      !view.damaged &&
      this.myState(view) === 'approved' &&
      !(view.ws.kind === 'server' && view.ws.role() === 'viewer')
    );
  }

  private isManager(view: View): boolean {
    if (!this.canWriteVault(view) || view.me === undefined) {
      return false;
    }
    return view.access.authority === 'signed' ? view.access.admins.has(view.me.keyId) : view.ws.role() === 'admin';
  }

  /** @throws team-secrets-damaged, team-secrets-pending, -removed, -declined, or team-secrets-admin-only */
  private async managerView(): Promise<{ view: View; me: MachineKeys }> {
    const view = await this.load(this.requireWorkspace());
    if (view.damaged) {
      throw teamSecretsError('team-secrets-damaged');
    }
    const state = this.myState(view);
    if (view.access.on && state !== 'approved') {
      throw notApprovedError(state);
    }
    if (!this.isManager(view) || view.me === undefined) {
      throw teamSecretsError('team-secrets-admin-only');
    }
    return { view, me: view.me };
  }

  private pendingKey(view: View, keyId: string): KeyInfo {
    const subject = view.access.keys.get(keyId);
    const removed = view.access.removed.some((removal) => removal.keyId === keyId);
    if (subject === undefined || view.access.approved.has(keyId) || removed) {
      throw teamSecretsError('team-secrets-no-such-key');
    }
    return subject;
  }

  private approvedKey(view: View, keyId: string): KeyInfo {
    const subject = view.access.keys.get(keyId);
    if (subject === undefined || !view.access.approved.has(keyId)) {
      throw teamSecretsError('team-secrets-no-such-key');
    }
    return subject;
  }

  private changeAdmin(keyId: string, action: 'grant-admin' | 'revoke-admin'): Promise<TeamSecretsStatusWire> {
    return this.enqueue(async () => {
      const { view, me } = await this.managerView();
      if (view.access.authority !== 'signed') {
        throw teamSecretsError('team-secrets-server-authority');
      }
      const subject = this.approvedKey(view, keyId);
      const entry = this.accessEntry(view, action, keyId, me);
      this.replayOrRefuse(view, entry);
      await this.write(view.ws, new Map([[accessEntryPath(entry.id), teamSecretsFileText(entry)]]));
      view.ws.afterWrite(
        action === 'grant-admin'
          ? `Make ${subject.name} a team secrets admin`
          : `Remove ${subject.name} as a team secrets admin`,
      );
      return await this.emit(view.ws);
    });
  }

  private accessEntry(view: View, action: AccessAction, key: string, me: MachineKeys) {
    const now = this.now();
    return signDocument(
      {
        version: 1 as const,
        id: nextAccessEntryId(
          view.files.access.map((entry) => entry.id),
          now.getTime(),
        ),
        action,
        key,
        by: me.keyId,
        at: now.toISOString(),
      },
      me,
    );
  }

  /**
   * The log replayed with `entry` appended. Every other machine replays it the same way, so an entry the
   * replay rejects is refused here instead of written.
   */
  private replayOrRefuse(view: View, entry: AccessEntryFile): AccessState {
    const next = replayAccessLog(
      view.access.keys,
      [...view.files.access, entry],
      view.local.genesisId !== undefined ? { genesisId: view.local.genesisId } : {},
    );
    const problem = next.problems.find((item) => item.id === entry.id);
    if (problem !== undefined) {
      throw refusal(problem.problem);
    }
    return next;
  }

  /** The vault entries the replay trusts and this machine does not refuse, by id. */
  protected trustedValues(view: View): Map<string, VaultEntryFile> {
    return new Map(
      [...view.files.values].filter(
        ([id, entry]) => verifyVaultEntry(entry, id, view.access) === 'trusted' && !view.refused.has(id),
      ),
    );
  }

  /**
   * The `updatedAt` for a new value of `id`: now, but always after the trusted entry it replaces, after what
   * this machine accepted, and after every removal, so a machine whose clock runs behind never writes a copy
   * others refuse as rolled back, nor one that still carries a Rotate mark.
   */
  protected nextUpdatedAt(view: View, id: string): string {
    const current = this.trustedValues(view).get(id)?.updatedAt;
    const accepted = view.local.accepted[id];
    const floor = Math.max(
      current === undefined ? 0 : Date.parse(current) + 1,
      accepted === undefined ? 0 : Date.parse(accepted) + 1,
      ...this.removalsOf(view).map((removal) => Date.parse(removal.at) + 1),
    );
    return new Date(Math.max(this.now().getTime(), floor)).toISOString();
  }

  /** Every removal the log replays now, and every one this machine saw before (§3.6), with the removed name. */
  protected removalsOf(view: View): { readonly keyId: string; readonly name: string; readonly at: string }[] {
    const removals = view.access.removed.map((removal) => ({
      keyId: removal.keyId,
      name: view.access.keys.get(removal.keyId)?.name ?? removal.keyId,
      at: removal.at,
    }));
    for (const seen of view.local.seenRemovals) {
      if (!removals.some((removal) => removal.keyId === seen.keyId)) {
        removals.push(seen);
      }
    }
    return removals;
  }

  /** Writes (text) or removes (`null`) tree files, announcing them to the watcher first. */
  protected async write(ws: TeamSecretsWorkspace, files: ReadonlyMap<string, string | null>): Promise<void> {
    ws.beforeWrite([...files.keys()]);
    for (const [path, text] of files) {
      const full = join(ws.tree, ...path.split('/'));
      if (text === null) {
        await rm(full, { force: true });
      } else {
        await mkdir(dirname(full), { recursive: true });
        await writeFile(full, text, 'utf8');
      }
    }
  }

  private async keyRequestText(ws: TeamSecretsWorkspace, keys: MachineKeys): Promise<{ text: string; name: string }> {
    const identity = await ws.identity().catch(() => undefined);
    const name = identity?.name || (this.deps.osUser ?? ((): string => userInfo().username))() || 'Someone';
    const machine = (this.deps.machine ?? hostname)() || 'this machine';
    const doc = signDocument(
      {
        version: 1 as const,
        keyId: keys.keyId,
        encryptionKey: keys.encryptionKey,
        signingKey: keys.signingKey,
        name,
        email: identity?.email ?? '',
        machine,
        requestedAt: this.now().toISOString(),
      },
      keys,
    );
    return { text: teamSecretsFileText(doc), name };
  }

  /**
   * §3.2: a file and a commit on git and folder shares; the route on a server share (plan decision 11). The
   * pull hook never waits on the route (plan decision 14); `wait` (the Request access button) does, and throws.
   */
  private async sendKeyRequest(
    ws: TeamSecretsWorkspace,
    keys: MachineKeys,
    options: { readonly wait?: boolean } = {},
  ): Promise<void> {
    const { text, name } = await this.keyRequestText(ws, keys);
    if (ws.kind === 'server') {
      if (options.wait === true) {
        await ws.requestKey?.(keys.keyId, text);
        return;
      }
      void ws.requestKey?.(keys.keyId, text).catch((error: unknown) => {
        this.deps.log?.(`[team-secrets] key request failed: ${error instanceof Error ? error.message : String(error)}`);
      });
      return;
    }
    await this.write(ws, new Map([[keyRequestPath(keys.keyId), text]]));
    ws.afterWrite(`Request team secrets access for ${name}`);
  }

  /** Makes a key and asks for access when this machine has neither asked nor been approved or removed. */
  protected async ensureRequested(view: View): Promise<void> {
    const state = this.myState(view);
    if (state !== 'none' && state !== 'pending') {
      return;
    }
    const keys = view.me ?? (await this.newKeys(view.ws));
    if (!view.access.keys.has(keys.keyId)) {
      await this.sendKeyRequest(view.ws, keys);
    }
  }

  private async turnOnNow(ws: TeamSecretsWorkspace, commit: boolean): Promise<void> {
    const view = await this.load(ws);
    if (view.access.on || view.damaged) {
      return;
    }
    if (ws.kind === 'server' && ws.role() !== 'admin') {
      throw teamSecretsError('team-secrets-admin-only');
    }
    const me = view.me ?? (await this.newKeys(ws));
    const { text } = await this.keyRequestText(ws, me);
    const genesis = signDocument(
      {
        version: 1 as const,
        id: nextAccessEntryId([], this.now().getTime()),
        action: 'genesis' as const,
        authority: ws.kind === 'server' ? ('server' as const) : ('signed' as const),
        key: me.keyId,
        by: me.keyId,
        at: this.now().toISOString(),
      },
      me,
    );
    const files = new Map<string, string | null>([
      [keyRequestPath(me.keyId), text],
      [accessEntryPath(genesis.id), teamSecretsFileText(genesis)],
    ]);
    if (ws.kind === 'git') {
      const attributes = await this.attributesWithMerge(ws);
      if (attributes !== undefined) {
        files.set(GIT_ATTRIBUTES_FILE, attributes);
      }
    }
    await this.write(ws, files);
    await writeLocalState(ws.dir, { ...view.local, genesisId: genesis.id, seenAccess: [genesis.id] });
    const values = await this.backfillFiles(await this.load(ws));
    if (values.size > 0) {
      await this.write(ws, values);
    }
    if (commit) {
      ws.afterWrite('Turn on team secrets');
    }
  }

  /** Plan decision 2: the tree's `.gitattributes` with the `-merge` line, or `undefined` when it has it. */
  private async attributesWithMerge(ws: TeamSecretsWorkspace): Promise<string | undefined> {
    let text: string;
    try {
      text = await readFile(join(ws.tree, GIT_ATTRIBUTES_FILE), 'utf8');
    } catch {
      return GIT_ATTRIBUTES;
    }
    if (text.split(/\r?\n/).some((line) => line.trim() === ATTRIBUTES_LINE)) {
      return undefined;
    }
    return `${text}${text.endsWith('\n') || text.length === 0 ? '' : '\n'}${ATTRIBUTES_LINE}\n`;
  }

  /** §3.1: an entry for every secret the workspace uses whose value this machine holds and the vault lacks. */
  protected async backfillFiles(view: View): Promise<Map<string, string | null>> {
    const out = new Map<string, string | null>();
    if (!this.canWriteVault(view) || view.me === undefined) {
      return out;
    }
    const recipients = approvedRecipients(view.access);
    const done = new Set<string>();
    for (const use of view.ws.uses()) {
      const id = vaultEntryId(use.secret);
      if (view.files.values.has(id) || done.has(id)) {
        continue;
      }
      done.add(id);
      const stored = await this.storedValue(use.secret);
      if (stored !== undefined) {
        const entry = buildVaultEntry({
          secret: use.secret,
          label: stored.label,
          value: stored.value,
          recipients,
          signer: view.me,
          at: this.nextUpdatedAt(view, id),
        });
        out.set(vaultEntryPath(id), teamSecretsFileText(entry));
      }
    }
    return out;
  }

  /** This machine's value for `secret`, with its display label; `undefined` when none is stored. */
  protected async storedValue(secret: SecretKey): Promise<{ value: string; label: string } | undefined> {
    const { store } = this.deps;
    if ('ref' in secret) {
      const value = await store.get(secret.ref);
      if (value === undefined) {
        return undefined;
      }
      const label = (await store.list()).find((entry) => entry.ref === secret.ref)?.label ?? secret.ref;
      return { value, label };
    }
    const ref = await store.findByLabel(secretStoreLabel(secret.token.projectId, secret.token.name));
    const value = ref === undefined ? undefined : await store.get(ref);
    return value === undefined ? undefined : { value, label: secret.token.name };
  }

  /** After a pull: ask, import, then heal, re-encrypt and backfill in one commit (§3.2, §3.4, plan decision 6). */
  protected async refreshNow(ws: TeamSecretsWorkspace): Promise<void> {
    const view = await this.load(ws);
    if (!view.access.on || view.damaged) {
      return;
    }
    await this.ensureRequested(view);
    const me = view.me;
    if (me === undefined || this.myState(view) !== 'approved') {
      return;
    }
    const trusted = this.trustedValues(view);
    for (const [id, entry] of view.files.values) {
      if (!trusted.has(id)) {
        const why =
          view.refused.get(id) === 'rolled-back'
            ? 'Ignored an older copy of a secret than the one this machine has'
            : TEAM_SECRETS_MESSAGES['team-secrets-untrusted'];
        this.deps.log?.(`[team-secrets] ${why} (${entry.label})`);
      }
    }
    const accepted = { ...view.local.accepted };
    for (const [id, entry] of trusted) {
      const value = openVaultEntry(entry, me);
      if (value !== undefined) {
        try {
          await this.importValue(entry.secret, entry.label, value);
        } catch (error) {
          // A ref naming one of this machine's own entries, which the store refuses: skip that one only.
          this.deps.log?.(
            `[team-secrets] could not store ${entry.label}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      const before = accepted[id];
      if (before === undefined || Date.parse(entry.updatedAt) > Date.parse(before)) {
        accepted[id] = entry.updatedAt;
      }
    }
    if (Object.entries(accepted).some(([id, at]) => view.local.accepted[id] !== at)) {
      await this.saveLocal(ws, { ...view.local, accepted });
    }
    if (!this.canWriteVault(view)) {
      return;
    }
    const files = new Map<string, string | null>();
    const recipients = approvedRecipients(view.access);
    for (const [id, entry] of trusted) {
      if (wrapsUnapprovedKey(entry, view.access)) {
        const value = openVaultEntry(entry, me);
        if (value !== undefined) {
          files.set(vaultEntryPath(id), teamSecretsFileText(sealVaultEntry(entry, value, recipients, me)));
        }
        continue;
      }
      const healed = healVaultEntry(entry, view.access, me);
      if (healed !== undefined) {
        files.set(vaultEntryPath(id), teamSecretsFileText(healed));
      }
    }
    for (const [path, text] of await this.backfillFiles(view)) {
      files.set(path, text);
    }
    if (files.size > 0) {
      await this.write(ws, files);
      ws.afterWrite('Update team secrets');
    }
  }

  /** Stores a vault value on this machine (the raw store: nothing goes back to the vault). */
  private async importValue(secret: SecretKey, label: string, value: string): Promise<void> {
    const { store } = this.deps;
    if ('ref' in secret) {
      if (forbiddenLabel({ secret, label })) {
        // `load` refuses such an entry already; a restored notice carries a label from the vault too.
        return;
      }
      if ((await store.get(secret.ref)) !== value) {
        await store.put(secret.ref, value, { label });
      }
      return;
    }
    const storeLabel = secretStoreLabel(secret.token.projectId, secret.token.name);
    const ref = await store.findByLabel(storeLabel);
    if (ref === undefined) {
      await store.set(value, { label: storeLabel });
    } else if ((await store.get(ref)) !== value) {
      await store.put(ref, value);
    }
  }

  protected async statusOf(view: View): Promise<TeamSecretsStatusWire> {
    const { access, me, ws } = view;
    if (!access.on && !view.damaged) {
      return {
        ...TEAM_SECRETS_OFF,
        canTurnOn: this.deps.store.encryptionAvailable() && (ws.kind !== 'server' || ws.role() === 'admin'),
        me: { state: this.myState(view), admin: false },
      };
    }
    const state = this.myState(view);
    const removed = new Set(access.removed.map((removal) => removal.keyId));
    const keyWire = (info: KeyInfo): TeamSecretsKeyWire => ({
      keyId: info.keyId,
      name: info.name,
      email: info.email,
      machine: info.machine,
      fingerprint: info.fingerprint,
      requestedAt: info.requestedAt,
      admin: access.admins.has(info.keyId),
      mine: info.keyId === me?.keyId,
    });
    const approved = approvedRecipients(access);
    const members = this.members;
    const message =
      state === 'unavailable'
        ? TEAM_SECRETS_MESSAGES['team-secrets-no-safe-storage']
        : view.damaged
          ? TEAM_SECRETS_MESSAGES['team-secrets-damaged']
          : state === 'removed'
            ? TEAM_SECRETS_MESSAGES['team-secrets-removed']
            : state === 'declined'
              ? TEAM_SECRETS_MESSAGES['team-secrets-declined']
              : undefined;
    const localOnly: SecretKey[] = [];
    if (!this.canWriteVault(view)) {
      for (const use of ws.uses()) {
        if ((await this.storedValue(use.secret)) !== undefined) {
          localOnly.push(use.secret);
        }
      }
    }
    return {
      on: true,
      ...(access.authority !== undefined ? { authority: access.authority } : {}),
      canTurnOn: false,
      canManage: this.isManager(view),
      me: {
        state,
        ...(me !== undefined ? { keyId: me.keyId, fingerprint: fingerprintOf(me) } : {}),
        admin: me !== undefined && access.admins.has(me.keyId),
      },
      ...(message !== undefined ? { message } : {}),
      pending: [...access.keys.values()]
        .filter((info) => !access.approved.has(info.keyId) && !removed.has(info.keyId))
        .map(keyWire),
      approved: approved.map(keyWire),
      formerMembers:
        ws.kind === 'server' && members !== undefined
          ? approved.filter((info) => !members.includes(info.email.toLowerCase())).map((info) => info.keyId)
          : [],
      rotate: rotateMarksFor(this.trustedValues(view), this.removalsOf(view)),
      untrusted: [...view.files.values]
        .filter(([id, entry]) => verifyVaultEntry(entry, id, access) !== 'trusted' || view.refused.has(id))
        .map(([entryId, entry]) => ({
          entryId,
          label: entry.label,
          ...(view.refused.get(entryId) === 'rolled-back' ? { reason: 'rolled-back' as const } : {}),
        })),
      replaced: view.local.replaced.map(({ entryId, label, byName }) => ({ entryId, label, byName })),
      localOnly,
    };
  }

  /**
   * Reports the status to `onChanged`; on a server share an admin's member list is refreshed behind it. A
   * member list the server could not give (`undefined`: offline, signed out) changes nothing.
   */
  protected async emit(ws: TeamSecretsWorkspace): Promise<TeamSecretsStatusWire> {
    const status = await this.statusOf(await this.load(ws));
    this.deps.onChanged?.(ws.workspaceId, status);
    if (ws.kind === 'server' && status.canManage && ws.memberEmails !== undefined) {
      void ws
        .memberEmails()
        .then(async (emails) => {
          if (this.ws !== ws || emails === undefined || sameList(emails, this.members)) {
            return;
          }
          this.members = emails;
          this.deps.onChanged?.(ws.workspaceId, await this.status());
        })
        .catch(() => undefined);
    }
    return status;
  }
}
