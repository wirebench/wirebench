import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { FolderOpen } from 'lucide-react';
import { Button } from '../../components/button.js';
import { ConfirmDialog } from '../../components/confirm-dialog.js';
import { BooleanSetting, SettingsGroup, TextSetting } from '../../components/settings-grid.js';
import { useSyncStore } from '../../state/sync.js';
import { useUiStore } from '../../state/ui.js';
import type { SyncLogEntryWire } from '../../../shared/wire-types.js';
import { workspaceActions } from '../workspace/workspace-actions.js';
import { formatRelative } from './relative-time.js';
import { syncBadgeLabel } from './sync-badge.js';

/**
 * The auto-fetch field's bounds — mirrors `syncSettingsPatchWireSchema.autoFetchSeconds`
 * (0-86,400 inclusive). Validated here, inline, before the channel is ever called, so a
 * rejected value never round-trips through main just to bounce back.
 */
const AUTO_FETCH_MIN = 0;
const AUTO_FETCH_MAX = 86_400;

/** How many commits the "recent commits" list asks main for. */
const LOG_LIMIT = 20;

/** These two settings are never sent back to the renderer (Task 9's wire has no field for
 * them) — the panel starts from the share defaults and reflects only what the user changes in
 * this session, rather than pretending to know a value main never told it. */
const INITIAL_COMMIT_ON_SAVE = true;
const INITIAL_PUSH_ON_SAVE = true;
const INITIAL_AUTO_FETCH_SECONDS = 60;

/**
 * The Sync panel: pull/push/fetch/commit, the unresolved conflicts, recent commits, the share's
 * settings, and the door out (reveal the shared folder, stop sharing). A Radix `Dialog`, opened
 * from the badge or `sync.openPanel`.
 */
export function SyncPanel() {
  const open = useUiStore((state) => state.syncPanelOpen);
  const setOpen = useUiStore((state) => state.setSyncPanelOpen);
  const setConflictResolverOpen = useUiStore((state) => state.setConflictResolverOpen);

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

  const [busy, setBusy] = useState<'pull' | 'push' | 'fetch' | 'commit' | undefined>(undefined);
  const [logEntries, setLogEntries] = useState<readonly SyncLogEntryWire[]>([]);
  const [commitMessage, setCommitMessage] = useState('');
  const [commitOnSave, setCommitOnSave] = useState(INITIAL_COMMIT_ON_SAVE);
  const [pushOnSave, setPushOnSave] = useState(INITIAL_PUSH_ON_SAVE);
  const [remote, setRemote] = useState(status.remote ?? '');
  const [branch, setBranch] = useState(status.branch ?? '');
  const [autoFetchSeconds, setAutoFetchSeconds] = useState(String(INITIAL_AUTO_FETCH_SECONDS));
  const [autoFetchError, setAutoFetchError] = useState<string | undefined>(undefined);
  const [stopSharingOpen, setStopSharingOpen] = useState(false);

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
    setRemote(status.remote ?? '');
    setBranch(status.branch ?? '');
    setAutoFetchSeconds(String(INITIAL_AUTO_FETCH_SECONDS));
    // Deliberately keyed on `open` alone: reloading the log/conflicts and resetting the drafts
    // on every `sync.statusChanged` would spam main and clobber in-progress edits while the
    // panel stays open.
  }, [open]);

  const run = (which: 'pull' | 'push' | 'fetch', action: () => Promise<void>): void => {
    setBusy(which);
    void action().finally(() => {
      setBusy(undefined);
    });
  };

  const submitCommit = (): void => {
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
                    onChange={(event) => {
                      setCommitMessage(event.target.value);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        submitCommit();
                      }
                    }}
                    className="h-row min-w-0 flex-1 rounded-md border border-hairline-strong bg-surface-base px-2 text-sm text-fg-default outline-none focus:ring-1 focus:ring-accent"
                  />
                  <Button data-testid="sync-commit" disabled={busy !== undefined} onClick={submitCommit}>
                    Commit
                  </Button>
                </>
              )}
            </div>

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
                      {entry.subject} · {entry.author} · {formatRelative(entry.at, new Date())}
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
