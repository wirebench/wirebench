import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { FolderOpen } from 'lucide-react';
import { Button } from '../../components/button.js';
import { ConfirmDialog } from '../../components/confirm-dialog.js';
import { BooleanSetting, SettingsGroup, TextSetting } from '../../components/settings-grid.js';
import { useSyncStore } from '../../state/sync.js';
import { useUiStore } from '../../state/ui.js';
import { useWorkspaceStore } from '../../state/workspace.js';
import type { SyncLogEntryWire, WorkspaceShareWire } from '../../../shared/wire-types.js';
import { workspaceActions } from '../workspace/workspace-actions.js';
import { formatRelative } from './relative-time.js';
import { syncBadgeLabel } from './sync-badge.js';
import { useNow } from './use-now.js';

/**
 * The auto-fetch field's bounds — mirrors `syncSettingsPatchWireSchema.autoFetchSeconds`
 * (0-86,400 inclusive). Validated here, inline, before the channel is ever called, so a
 * rejected value never round-trips through main just to bounce back.
 */
const AUTO_FETCH_MIN = 0;
const AUTO_FETCH_MAX = 86_400;

/** How many commits the "recent commits" list asks main for. */
const LOG_LIMIT = 20;

/** How often the log rows' relative times refresh while the panel is open. */
const RELATIVE_TIME_REFRESH_MS = 30_000;

/**
 * Fallbacks for a `git` share whose `WorkspaceShareWire` predates these fields (or, in
 * principle, omits them) — mirrors `DEFAULT_GIT_SHARE_SETTINGS` in `@wirebench/engine`. Real
 * values always come from `workspace.share` once main fills them in; these are never shown in
 * place of a persisted value, only in place of a genuinely missing one.
 */
const DEFAULT_COMMIT_ON_SAVE = true;
const DEFAULT_PUSH_ON_SAVE = true;
const DEFAULT_AUTO_FETCH_SECONDS = 60;

/** Reads a `git` share's settings, falling back only for a field main genuinely never sent. */
function settingsOf(share: WorkspaceShareWire | undefined): {
  commitOnSave: boolean;
  pushOnSave: boolean;
  autoFetchSeconds: number;
  remote: string;
  branch: string;
} {
  return {
    commitOnSave: share?.commitOnSave ?? DEFAULT_COMMIT_ON_SAVE,
    pushOnSave: share?.pushOnSave ?? DEFAULT_PUSH_ON_SAVE,
    autoFetchSeconds: share?.autoFetchSeconds ?? DEFAULT_AUTO_FETCH_SECONDS,
    remote: share?.remote ?? '',
    branch: share?.branch ?? '',
  };
}

/**
 * The Sync panel: pull/push/fetch/commit, the unresolved conflicts, recent commits, the share's
 * settings, and the door out (reveal the shared folder, stop sharing). A Radix `Dialog`, opened
 * from the badge or `sync.openPanel`.
 */
export function SyncPanel() {
  const open = useUiStore((state) => state.syncPanelOpen);
  const setOpen = useUiStore((state) => state.setSyncPanelOpen);
  const setConflictResolverOpen = useUiStore((state) => state.setConflictResolverOpen);

  const share = useWorkspaceStore((state) => state.workspace?.share);
  const status = useSyncStore((state) => state.status);
  const conflicts = useSyncStore((state) => state.conflicts);
  const pull = useSyncStore((state) => state.pull);
  const push = useSyncStore((state) => state.push);
  const fetch = useSyncStore((state) => state.fetch);
  const commit = useSyncStore((state) => state.commit);
  const loadConflicts = useSyncStore((state) => state.loadConflicts);
  const log = useSyncStore((state) => state.log);
  const updateSettings = useSyncStore((state) => state.updateSettings);
  const revealTree = useSyncStore((state) => state.revealTree);
  // Ticks only while the panel is actually shown — `useNow` still has to be called
  // unconditionally (the Rules of Hooks), so "off" is expressed as a non-positive interval.
  const now = useNow(open ? RELATIVE_TIME_REFRESH_MS : 0);

  const [busy, setBusy] = useState<'pull' | 'push' | 'fetch' | 'commit' | undefined>(undefined);
  const [logEntries, setLogEntries] = useState<readonly SyncLogEntryWire[]>([]);
  const [commitMessage, setCommitMessage] = useState('');
  const initial = settingsOf(share);
  const [commitOnSave, setCommitOnSave] = useState(initial.commitOnSave);
  const [pushOnSave, setPushOnSave] = useState(initial.pushOnSave);
  const [remote, setRemote] = useState(initial.remote);
  const [branch, setBranch] = useState(initial.branch);
  const [autoFetchSeconds, setAutoFetchSeconds] = useState(String(initial.autoFetchSeconds));
  const [autoFetchError, setAutoFetchError] = useState<string | undefined>(undefined);
  const [stopSharingOpen, setStopSharingOpen] = useState(false);

  // Re-syncs the settings controls whenever a new workspace snapshot arrives (a settings save —
  // this panel's own or another window's — always broadcasts one). Deliberately does *not*
  // include `open`: a hardcoded reset on every open/close cycle would throw away a persisted
  // value in favour of a made-up default, which is exactly last round's bug.
  useEffect(() => {
    const next = settingsOf(share);
    setCommitOnSave(next.commitOnSave);
    setPushOnSave(next.pushOnSave);
    setRemote(next.remote);
    setBranch(next.branch);
    setAutoFetchSeconds(String(next.autoFetchSeconds));
    // Deliberately depends on the persisted primitives, not on `share` itself: `shareWire()`
    // (main/workspace-service.ts) builds a brand-new `share` object on *every* `onChanged`
    // broadcast — a rename, an environment edit, a project add/remove — not only when settings
    // actually change. Keying on the object would re-run (and reset every draft below, wiping
    // an uncommitted keystroke) on any of those unrelated workspace mutations while the panel
    // is open. A genuine persisted change arriving mid-edit can still overwrite a draft — that
    // is accepted, not worked around with dirty-tracking.
  }, [share?.kind, share?.remote, share?.branch, share?.autoFetchSeconds, share?.commitOnSave, share?.pushOnSave]);

  useEffect(() => {
    if (!open) {
      return;
    }
    void loadConflicts();
    void (async () => {
      setLogEntries(await log(LOG_LIMIT));
    })();
    setCommitMessage('');
    setAutoFetchError(undefined);
    // Deliberately keyed on `open` alone: reloading the log/conflicts on every
    // `sync.statusChanged` would spam main while the panel stays open for a while.
  }, [open, loadConflicts, log]);

  const run = (which: 'pull' | 'push' | 'fetch', action: () => Promise<void>): void => {
    setBusy(which);
    void action().finally(() => {
      setBusy(undefined);
    });
  };

  const submitCommit = (): void => {
    if (busy !== undefined) {
      // A pull/push/fetch (or another commit) is already in flight — the message field stays
      // disabled while that is true, but Enter races the state update in some event orders, so
      // this is the actual guard against a second, concurrent `commit()`.
      return;
    }
    setBusy('commit');
    const trimmed = commitMessage.trim();
    void commit(trimmed.length === 0 ? undefined : trimmed).finally(() => {
      setBusy(undefined);
      setCommitMessage('');
    });
  };

  const commitAutoFetch = (text: string): void => {
    const trimmed = text.trim();
    const parsed = Number(trimmed);
    if (!Number.isInteger(parsed) || parsed < AUTO_FETCH_MIN || parsed > AUTO_FETCH_MAX) {
      setAutoFetchError(`Enter a whole number of seconds from ${String(AUTO_FETCH_MIN)} to ${String(AUTO_FETCH_MAX)}.`);
      return;
    }
    setAutoFetchError(undefined);
    setAutoFetchSeconds(String(parsed));
    void updateSettings({ autoFetchSeconds: parsed });
  };

  return (
    <>
      <Dialog.Root open={open} onOpenChange={setOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 bg-black/40" />
          <Dialog.Content
            data-testid="sync-panel"
            className="fixed top-1/2 left-1/2 flex max-h-[80vh] w-[34rem] -translate-x-1/2 -translate-y-1/2 flex-col overflow-auto rounded-md bg-surface-raised p-4 shadow-lg"
          >
            <Dialog.Title className="text-md font-medium text-fg-default">Sync</Dialog.Title>
            <Dialog.Description className="mt-1 text-xs text-fg-subtle">
              {status.remote === undefined
                ? `${syncBadgeLabel(status)} — no remote set yet.`
                : `${status.remote} on ${status.branch ?? 'main'}`}
            </Dialog.Description>

            <div className="mt-3 flex gap-2">
              <Button
                data-testid="sync-pull"
                disabled={busy !== undefined}
                onClick={() => {
                  run('pull', pull);
                }}
              >
                Pull
              </Button>
              <Button
                data-testid="sync-push"
                disabled={busy !== undefined}
                onClick={() => {
                  run('push', push);
                }}
              >
                Push
              </Button>
              <Button
                data-testid="sync-fetch"
                disabled={busy !== undefined}
                onClick={() => {
                  run('fetch', fetch);
                }}
              >
                Fetch
              </Button>
              {!commitOnSave && (
                <>
                  <input
                    data-testid="sync-commit-message"
                    aria-label="Commit message"
                    placeholder="Commit message (optional)"
                    value={commitMessage}
                    disabled={busy !== undefined}
                    onChange={(event) => {
                      setCommitMessage(event.target.value);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        submitCommit();
                      }
                    }}
                    className="h-row min-w-0 flex-1 rounded-md border border-hairline-strong bg-surface-base px-2 text-sm text-fg-default outline-none focus:ring-1 focus:ring-accent disabled:opacity-60"
                  />
                  <Button data-testid="sync-commit" disabled={busy !== undefined} onClick={submitCommit}>
                    Commit
                  </Button>
                </>
              )}
            </div>

            {status.held !== undefined && (
              <div
                role="status"
                data-testid="sync-held-banner"
                className="mt-3 flex items-center gap-3 rounded-md border border-hairline bg-surface-sunken px-3 py-1.5 text-sm text-fg-default"
              >
                <span className="min-w-0 flex-1">
                  Commit held — {status.held.findings}{' '}
                  {status.held.findings === 1 ? 'possible secret' : 'possible secrets'}
                </span>
                {/* The manual commit's own review: once every finding is moved or kept main runs the
                    held commit, and "Commit anyway" commits in its place. */}
                <Button data-testid="sync-held-review" disabled={busy !== undefined} onClick={submitCommit}>
                  Review
                </Button>
              </div>
            )}

            {conflicts.length > 0 && (
              <SettingsGroup title="Conflicts">
                <ul data-testid="sync-panel-conflicts" className="flex flex-col gap-1">
                  {conflicts.map((conflict) => (
                    <li key={conflict.path} className="flex items-center justify-between gap-2 text-sm text-fg-default">
                      <span className="min-w-0 truncate" title={conflict.path}>
                        {conflict.entity !== undefined
                          ? `${conflict.entity.kind}: ${conflict.entity.name}`
                          : conflict.path}
                      </span>
                      <Button
                        onClick={() => {
                          setConflictResolverOpen(true);
                        }}
                      >
                        Resolve…
                      </Button>
                    </li>
                  ))}
                </ul>
              </SettingsGroup>
            )}

            <SettingsGroup title="Recent commits">
              {logEntries.length === 0 ? (
                <p className="text-sm text-fg-subtle">No commits yet.</p>
              ) : (
                <ul className="flex flex-col gap-1">
                  {logEntries.map((entry) => (
                    <li
                      key={entry.id}
                      data-testid="sync-log-row"
                      className="truncate text-sm text-fg-default"
                      title={entry.subject}
                    >
                      {entry.subject} · {entry.author} · {formatRelative(entry.at, now)}
                    </li>
                  ))}
                </ul>
              )}
            </SettingsGroup>

            <SettingsGroup title="Settings">
              <BooleanSetting
                label="Commit on save"
                value={commitOnSave}
                onChange={(value) => {
                  setCommitOnSave(value);
                  void updateSettings({ commitOnSave: value });
                }}
              />
              <BooleanSetting
                label="Push on save"
                value={pushOnSave}
                onChange={(value) => {
                  setPushOnSave(value);
                  void updateSettings({ pushOnSave: value });
                }}
              />
              <TextSetting label="Auto-fetch every N seconds" value={autoFetchSeconds} onCommit={commitAutoFetch} />
              {autoFetchError !== undefined && <p className="mt-1 text-xs text-status-danger">{autoFetchError}</p>}
              <TextSetting
                label="Remote"
                value={remote}
                onCommit={(value) => {
                  setRemote(value);
                  void updateSettings({ remote: value.trim() });
                }}
              />
              <TextSetting
                label="Branch"
                value={branch}
                onCommit={(value) => {
                  setBranch(value);
                  void updateSettings({ branch: value.trim() });
                }}
              />
            </SettingsGroup>

            <div className="mt-4 flex justify-between gap-2">
              <Button
                data-testid="sync-reveal-tree"
                onClick={() => {
                  void revealTree();
                }}
              >
                <FolderOpen size={14} aria-hidden="true" />
                Reveal shared folder
              </Button>
              <div className="flex gap-2">
                <Button
                  data-testid="sync-stop-sharing"
                  onClick={() => {
                    setStopSharingOpen(true);
                  }}
                >
                  Stop sharing…
                </Button>
                <Dialog.Close asChild>
                  <Button>Close</Button>
                </Dialog.Close>
              </div>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <ConfirmDialog
        open={stopSharingOpen}
        onOpenChange={setStopSharingOpen}
        title="Stop sharing?"
        description="This workspace becomes local-only again. Its history stays on disk; other members keep their own copies."
        confirmLabel="Stop sharing"
        destructive
        confirmTestId="sync-stop-sharing-confirm"
        onConfirm={() => {
          setStopSharingOpen(false);
          setOpen(false);
          void workspaceActions.stopSharing();
        }}
      />
    </>
  );
}
