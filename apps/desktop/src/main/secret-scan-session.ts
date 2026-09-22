/**
 * Secret scanning for the open projects, in main (docs/specs/2026-09-22-secret-scanning-design.md):
 * what a scan shows the review dialog, the session-only Keep list, and Move — the value into the
 * store under the project's label for its name, the project rewritten to carry a `${secret:name}`
 * token in its place.
 *
 * Values stay here. A finding leaves main as {@link SecretFindingWire} — a masked preview — and
 * Move is addressed by finding id, so the renderer never holds a value in either direction.
 */
import {
  applySecretMoves,
  maskedPreview,
  proposeSecretName,
  scanProjectForSecrets,
  SECRET_NAME_PATTERN,
} from '@wirebench/engine';
import type { SecretFinding, SecretMove } from '@wirebench/engine';
import type { SecretFindingWire } from '../shared/wire-types.js';
import type { ProjectHost } from './project-host.js';
import { secretStoreLabel } from './secret-resolver.js';
import type { SecretStore } from './secrets.js';

/** What a session needs from the project's host: the model, and one way to rewrite it. */
export type SecretScanHost = Pick<ProjectHost, 'model' | 'applyModelUpdate'>;

/** What a session needs from the secret store. */
export type SecretScanStore = Pick<SecretStore, 'set' | 'replace' | 'delete' | 'findByLabel' | 'list'>;

/** One finding to move, by id, and the name its token will carry. */
export interface SecretMoveItem {
  readonly id: string;
  readonly name: string;
  /** Overwrite a value already stored under `name`; without it a taken name is not moved. */
  readonly replace?: boolean | undefined;
}

/** What a {@link SecretScanSession.move} did, as finding ids. */
export interface SecretMoveResult {
  readonly moved: string[];
  /** Not found by a fresh scan (edited, moved or removed since), or not rewritten. */
  readonly stale: string[];
  /** Its name already has a stored value and `replace` was not set. */
  readonly nameTaken: string[];
}

/** What the review dialog opens with; see `secretScanScanResponseSchema`. */
export interface SecretScanReview {
  readonly findings: SecretFindingWire[];
  readonly proposedNames: Record<string, string>;
  readonly storedNames: string[];
}

function toWire(finding: SecretFinding): SecretFindingWire {
  return {
    id: finding.id,
    location: finding.location,
    rule: finding.rule,
    label: finding.label,
    preview: maskedPreview(finding.value),
  };
}

/**
 * One open project's scanning state. Keep is in memory only and ends with the session: a finding id
 * hashes its location and value, so a kept value that is edited is found again.
 */
export class SecretScanSession {
  private readonly kept = new Set<string>();
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly projectId: string,
    private readonly host: () => SecretScanHost,
    private readonly store: SecretScanStore,
  ) {}

  /** The findings in the project as it stands, minus the ones kept this session. */
  scan(): SecretFindingWire[] {
    return this.unkept().map(toWire);
  }

  /** {@link scan}, with a proposed name for each finding and the names already stored. */
  async review(): Promise<SecretScanReview> {
    const findings = this.unkept();
    const storedNames = await this.storedNames();
    const taken = new Set(storedNames);
    const proposedNames: Record<string, string> = {};
    for (const finding of findings) {
      const name = proposeSecretName(finding, taken);
      proposedNames[finding.id] = name;
      taken.add(name);
    }
    return { findings: findings.map(toWire), proposedNames, storedNames };
  }

  /** Leaves these findings where they are until the project closes (or their value changes). */
  keep(ids: readonly string[]): void {
    for (const id of ids) {
      this.kept.add(id);
    }
    this.emit();
  }

  /**
   * Moves each finding's value into the store and rewrites the project to carry a token instead.
   *
   * The findings are looked up by a fresh scan, so an id whose value was edited since is `stale`.
   * The value stored is the finding's text exactly as it stands in the file (still JSON-, XML- or
   * URL-escaped where it was), because a token expands verbatim. Each name is stored once: `set`
   * under the project's label, or `replace` when the name exists and the item asks to; a name that
   * exists without `replace` is reported in `nameTaken` and that finding stays. Then every stored
   * move is applied to the model as one change.
   *
   * The store writes are awaited while the user may still be editing, so a finding can go stale
   * part-way. Each one is checked against the model as it stands just before its write (skipped,
   * `stale`, if it no longer applies) and again by the final update. An entry this call created
   * with `set` whose findings all went stale by then is deleted again. A `replace` cannot be undone
   * that way: a finding edited after its check but before the update (while its own or a later
   * item's write is in flight) leaves the name's old value replaced, though no token is written
   * for it — a narrow race, left as is.
   */
  async move(items: readonly SecretMoveItem[]): Promise<SecretMoveResult> {
    const model = this.host().model();
    const found = new Map((model === undefined ? [] : scanProjectForSecrets(model)).map((f) => [f.id, f]));
    const stale: string[] = [];
    const nameTaken: string[] = [];
    const moves: SecretMove[] = [];
    // Two findings may share a name in one call (the same token pasted twice): one store write.
    const storedNow = new Map<string, { readonly value: string; readonly created?: string }>();
    for (const item of items) {
      const finding = found.get(item.id);
      if (finding === undefined || !SECRET_NAME_PATTERN.test(item.name)) {
        stale.push(item.id);
        continue;
      }
      const move: SecretMove = { finding, name: item.name };
      const already = storedNow.get(item.name);
      if (already !== undefined) {
        if (already.value === finding.value) {
          moves.push(move);
        } else {
          nameTaken.push(item.id);
        }
        continue;
      }
      const label = secretStoreLabel(this.projectId, item.name);
      const ref = await this.store.findByLabel(label);
      if (ref !== undefined && item.replace !== true) {
        nameTaken.push(item.id);
        continue;
      }
      // After the lookup, right before the write: edited meanwhile, and nothing is stored for it.
      if (!this.applies(move)) {
        stale.push(item.id);
        continue;
      }
      if (ref === undefined) {
        storedNow.set(item.name, { value: finding.value, created: await this.store.set(finding.value, { label }) });
      } else {
        await this.store.replace(ref, finding.value);
        storedNow.set(item.name, { value: finding.value });
      }
      moves.push(move);
    }

    let applied = new Set<string>();
    if (moves.length > 0) {
      this.host().applyModelUpdate((current) => {
        const result = applySecretMoves(current, moves);
        applied = new Set(Object.keys(result.values));
        return result.project;
      });
    }
    const ids = [...new Set(moves.map((m) => m.finding.id))];
    const moved = ids.filter((id) => applied.has(id));
    stale.push(...ids.filter((id) => !applied.has(id)));
    // An entry created here that no token names: its findings went stale during the writes.
    for (const [name, stored] of storedNow) {
      const used = moves.some((m) => m.name === name && applied.has(m.finding.id));
      if (stored.created !== undefined && !used) {
        await this.store.delete(stored.created);
      }
    }
    if (moved.length > 0) {
      this.emit();
    }
    return { moved, stale, nameTaken };
  }

  /** True while `move` would still rewrite the model as it stands now. */
  private applies(move: SecretMove): boolean {
    const model = this.host().model();
    return model !== undefined && move.finding.id in applySecretMoves(model, [move]).values;
  }

  /** Called after every keep and every move that changed something; returns the unsubscribe. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Forgets the kept ids and the listeners: the project closed. */
  dispose(): void {
    this.kept.clear();
    this.listeners.clear();
  }

  private unkept(): SecretFinding[] {
    const model = this.host().model();
    return model === undefined ? [] : scanProjectForSecrets(model).filter((finding) => !this.kept.has(finding.id));
  }

  /** The token names this project already has a value stored for on this machine. */
  private async storedNames(): Promise<string[]> {
    const prefix = secretStoreLabel(this.projectId, '');
    return (await this.store.list())
      .map((entry) => entry.label)
      .filter((label): label is string => label?.startsWith(prefix) === true)
      .map((label) => label.slice(prefix.length));
  }

  private emit(): void {
    for (const listener of [...this.listeners]) {
      listener();
    }
  }
}

/** Everything {@link SecretScanSessions} needs. */
export interface SecretScanSessionsDeps {
  /** The host of an open project; throws for a project that is not open (`WorkspaceService.hostFor`). */
  readonly host: (projectId: string) => SecretScanHost;
  readonly store: SecretScanStore;
}

/** The {@link SecretScanSession} of every open project, made on first use and dropped on close. */
export class SecretScanSessions {
  private readonly sessions = new Map<string, SecretScanSession>();

  constructor(private readonly deps: SecretScanSessionsDeps) {}

  /** The session of `projectId`; throws, making none, when that project is not open. */
  session(projectId: string): SecretScanSession {
    let session = this.sessions.get(projectId);
    if (session === undefined) {
      this.deps.host(projectId);
      session = new SecretScanSession(projectId, () => this.deps.host(projectId), this.deps.store);
      this.sessions.set(projectId, session);
    }
    return session;
  }

  /**
   * What main's `onProjectChanged` hook calls with every change it announces: `null` is the project
   * closing, which ends its session; anything else is an edit, which a session reads as it goes.
   */
  projectChanged(projectId: string, project: unknown): void {
    if (project === null) {
      this.close(projectId);
    }
  }

  /** Ends the session of a project that closed: its kept findings are found again next time. */
  close(projectId: string): void {
    this.sessions.get(projectId)?.dispose();
    this.sessions.delete(projectId);
  }
}
