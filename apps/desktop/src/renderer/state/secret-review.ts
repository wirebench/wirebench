/**
 * The secret review a manual save runs before writing (and, from Sync, a manual commit before
 * committing): docs/specs/2026-09-22-secret-scanning-design.md, decisions 8 and 9.
 *
 * Main scans and answers with masked previews; Move and Keep go back by finding id and name. No
 * value is ever held here, in either direction. {@link reviewSecrets} is the whole API a caller
 * needs: it resolves `proceed` when there is nothing to review, when the person moves or keeps
 * every finding, or when they go ahead anyway, and `cancel` when they back out.
 */
import { create } from 'zustand';
import { SECRET_NAME_PATTERN } from '@wirebench/engine/rest';
import type { IpcError } from '../../shared/ipc.js';
import type { SecretFindingWire } from '../../shared/wire-types.js';
import { showToast } from '../components/toast.js';
import { ipc } from './ipc-client.js';
import { useProjectStore } from './project.js';

/** What the review stands in front of; only the wording of the go-ahead button differs. */
export type SecretReviewMode = 'save' | 'commit';

/** Whether the save (or commit) that asked should go ahead. */
export type SecretReviewOutcome = 'proceed' | 'cancel';

/** One finding as the dialog shows it, with what the person has made of it so far. */
export interface SecretReviewRow {
  /** Project and finding id together: two projects may hold the same value at the same path. */
  readonly key: string;
  readonly projectId: string;
  readonly finding: SecretFindingWire;
  /** The `${secret:name}` name to move it to: main's proposal until edited. */
  readonly name: string;
  /** "Replace the stored value" is ticked. */
  readonly replace: boolean;
  /** The last Move found this name already stored and was not asked to replace it. */
  readonly nameTaken: boolean;
  /** The last Move found the value changed since it was scanned. */
  readonly stale: boolean;
}

/** The review on screen. */
export interface SecretReview {
  readonly mode: SecretReviewMode;
  readonly projectIds: readonly string[];
  readonly rows: readonly SecretReviewRow[];
  /** Per project, the names it already has a value stored for on this machine. */
  readonly storedNames: Readonly<Record<string, readonly string[]>>;
  /** A Move, Keep or re-scan is in flight. */
  readonly busy: boolean;
  /** Why the last action failed, when it did. */
  readonly error?: string | undefined;
  /** What the last action could not do to a row that is no longer listed. */
  readonly notice?: string | undefined;
}

interface SecretReviewState {
  /** The review on screen, or `null` when none is. */
  readonly review: SecretReview | null;
  readonly setName: (key: string, name: string) => void;
  readonly setReplace: (key: string, replace: boolean) => void;
  /** Moves these rows' findings into the store, then re-scans. Refused while any name is invalid. */
  readonly move: (keys: readonly string[]) => Promise<void>;
  readonly moveAll: () => Promise<void>;
  /** Leaves these rows' findings in place for the session, then re-scans. */
  readonly keep: (keys: readonly string[]) => Promise<void>;
  /** "Save anyway" / "Commit anyway": goes ahead with the findings where they are, unkept. */
  readonly proceed: () => void;
  /** Cancel, Escape: nothing is written. */
  readonly cancel: () => void;
}

/** Why `name` cannot be a secret name, or `undefined` when it can. */
export function secretNameError(name: string): string | undefined {
  if (name.length === 0) {
    return 'Enter a name.';
  }
  return SECRET_NAME_PATTERN.test(name) ? undefined : 'Use letters, digits and underscores, not starting with a digit.';
}

/** True when Move to `row.name` would overwrite a stored value, so the person must say so. */
export function needsReplace(review: SecretReview, row: SecretReviewRow): boolean {
  return row.nameTaken || (review.storedNames[row.projectId] ?? []).includes(row.name);
}

function rowKey(projectId: string, findingId: string): string {
  return `${projectId}\u0000${findingId}`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: IpcError }): T {
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.value;
}

interface Scanned {
  readonly rows: SecretReviewRow[];
  readonly storedNames: Record<string, readonly string[]>;
}

/**
 * Scans each project and lays the answer over the rows already on screen: a finding still there
 * keeps the name and the choice the person made for it; a new one starts from main's proposal.
 */
async function scan(
  projectIds: readonly string[],
  previous: readonly SecretReviewRow[] = [],
  marks: { readonly nameTaken?: ReadonlySet<string>; readonly stale?: ReadonlySet<string> } = {},
): Promise<Scanned> {
  const before = new Map(previous.map((row) => [row.key, row]));
  const rows: SecretReviewRow[] = [];
  const storedNames: Record<string, readonly string[]> = {};
  for (const projectId of projectIds) {
    const answer = unwrap(await ipc().secretScan.scan({ projectId }));
    storedNames[projectId] = answer.storedNames;
    for (const finding of answer.findings) {
      const key = rowKey(projectId, finding.id);
      const kept = before.get(key);
      rows.push({
        key,
        projectId,
        finding,
        name: kept?.name ?? answer.proposedNames[finding.id] ?? '',
        replace: kept?.replace ?? false,
        nameTaken: marks.nameTaken?.has(key) ?? false,
        stale: marks.stale?.has(key) ?? false,
      });
    }
  }
  return { rows, storedNames };
}

/** Rows grouped by project, in the order they appear. */
function byProject(rows: readonly SecretReviewRow[]): Map<string, SecretReviewRow[]> {
  const groups = new Map<string, SecretReviewRow[]>();
  for (const row of rows) {
    groups.set(row.projectId, [...(groups.get(row.projectId) ?? []), row]);
  }
  return groups;
}

/** Resolves the review on screen; `undefined` while none is waiting. */
let settle: ((outcome: SecretReviewOutcome) => void) | undefined;
/** Set from the moment a review is asked for (its scan included) until it is answered. */
let active = false;
/** Bumped per review, so an action still in flight when its review ended changes nothing. */
let session = 0;

export const useSecretReviewStore = create<SecretReviewState>((set, get) => {
  const patchRow = (key: string, patch: Partial<SecretReviewRow>): void => {
    const review = get().review;
    if (review === null) {
      return;
    }
    set({ review: { ...review, rows: review.rows.map((row) => (row.key === key ? { ...row, ...patch } : row)) } });
  };

  const finish = (outcome: SecretReviewOutcome): void => {
    const resolve = settle;
    settle = undefined;
    session += 1;
    set({ review: null });
    resolve?.(outcome);
  };

  /**
   * Runs one Move or Keep against main, then re-scans so the list shows what is actually left —
   * including a finding that changed meanwhile, which comes back under a new id. With nothing
   * left, the review is over and the save goes ahead.
   */
  const act = async (run: () => Promise<{ nameTaken?: Set<string>; stale?: Set<string> }>): Promise<void> => {
    const review = get().review;
    if (review === null || review.busy) {
      return;
    }
    const mine = session;
    set({ review: { ...review, busy: true, error: undefined, notice: undefined } });
    try {
      const marks = await run();
      const current = get().review;
      if (mine !== session || current === null) {
        return;
      }
      const next = await scan(review.projectIds, current.rows, marks);
      if (mine !== session) {
        return;
      }
      if (next.rows.length === 0) {
        finish('proceed');
        return;
      }
      // A value edited since the scan is found again under a new id, so its old row is gone and
      // cannot carry the note itself.
      const listed = new Set(next.rows.map((row) => row.key));
      const vanished = [...(marks.stale ?? [])].some((key) => !listed.has(key));
      set({
        review: {
          ...current,
          rows: next.rows,
          storedNames: next.storedNames,
          busy: false,
          notice: vanished
            ? 'A value changed while you were reviewing; the list now shows it as it stands.'
            : undefined,
        },
      });
    } catch (error) {
      const current = get().review;
      if (mine === session && current !== null) {
        set({ review: { ...current, busy: false, error: messageOf(error) } });
      }
    }
  };

  const move = async (keys: readonly string[]): Promise<void> => {
    const review = get().review;
    const rows = review?.rows.filter((row) => keys.includes(row.key)) ?? [];
    // The buttons are disabled as well; this is the rule itself, for any other caller.
    if (rows.length === 0 || rows.some((row) => secretNameError(row.name) !== undefined)) {
      return;
    }
    await act(async () => {
      const nameTaken = new Set<string>();
      const stale = new Set<string>();
      for (const [projectId, group] of byProject(rows)) {
        const result = unwrap(
          await ipc().secretScan.move({
            projectId,
            items: group.map((row) => ({
              id: row.finding.id,
              name: row.name,
              ...(row.replace ? { replace: true } : {}),
            })),
          }),
        );
        for (const id of result.nameTaken) {
          nameTaken.add(rowKey(projectId, id));
        }
        for (const id of result.stale) {
          stale.add(rowKey(projectId, id));
        }
      }
      return { nameTaken, stale };
    });
  };

  return {
    review: null,

    setName: (key, name) => {
      // A new name is a new question: whatever the last Move said about the old one is moot.
      patchRow(key, { name, nameTaken: false, stale: false });
    },

    setReplace: (key, replace) => {
      patchRow(key, { replace });
    },

    move,

    moveAll: async () => {
      await move(get().review?.rows.map((row) => row.key) ?? []);
    },

    keep: async (keys) => {
      const rows = get().review?.rows.filter((row) => keys.includes(row.key)) ?? [];
      if (rows.length === 0) {
        return;
      }
      await act(async () => {
        for (const [projectId, group] of byProject(rows)) {
          unwrap(await ipc().secretScan.keep({ projectId, ids: group.map((row) => row.finding.id) }));
        }
        return {};
      });
    },

    proceed: () => {
      if (get().review !== null) {
        finish('proceed');
      }
    },

    cancel: () => {
      if (get().review !== null) {
        finish('cancel');
      }
    },
  };
});

/**
 * Reviews `projectIds` (every open project by default) for plain-text secrets before a manual
 * save or commit, and says whether it should go ahead.
 *
 * Nothing found: `proceed`, with nothing shown. Otherwise the review dialog opens and this settles
 * when the person answers it. A failed scan is `cancel`, with a toast: going ahead unchecked is
 * exactly what the review is there to prevent, and the save can simply be tried again.
 *
 * One review at a time. A call while another is open — or still scanning — is refused with
 * `cancel` straight away and scans nothing: the open dialog is the question on screen, and its
 * answer belongs to the save (or commit) that asked it. Folding a second caller into that answer
 * would let a "Save anyway" stand for a commit nobody reviewed.
 */
export async function reviewSecrets(
  mode: SecretReviewMode,
  projectIds: readonly string[] = Object.keys(useProjectStore.getState().projects),
): Promise<SecretReviewOutcome> {
  if (active) {
    return 'cancel';
  }
  active = true;
  try {
    let scanned: Scanned;
    try {
      scanned = await scan(projectIds);
    } catch (error) {
      showToast(`Could not check for secrets: ${messageOf(error)}`);
      return 'cancel';
    }
    if (scanned.rows.length === 0) {
      return 'proceed';
    }
    return await new Promise<SecretReviewOutcome>((resolve) => {
      settle = resolve;
      useSecretReviewStore.setState({
        review: {
          mode,
          projectIds: [...projectIds],
          rows: scanned.rows,
          storedNames: scanned.storedNames,
          busy: false,
        },
      });
    });
  } finally {
    active = false;
  }
}
