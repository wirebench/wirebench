import { useEffect, useState } from 'react';
import { Folder, FolderInput, FolderPlus, FolderSearch, GitBranch, Server } from 'lucide-react';
import { Button } from '../../components/button.js';
import { remoteHost } from '../sync/remote-host.js';
import { useAccountStore } from '../../state/account.js';
import { useUiStore } from '../../state/ui.js';
import { useWorkspaceStore } from '../../state/workspace.js';
import type { WorkspaceShareWire } from '../../../shared/wire-types.js';
import { workspaceActions } from './workspace-actions.js';

/** The kind glyph plus the least a row may say about a share, never the full URL. */
function ShareGlyph({ share }: { readonly share: WorkspaceShareWire }) {
  if (share.kind === 'folder') {
    return (
      <span data-testid="workspace-picker-share" className="inline-flex items-center gap-1 text-xs text-fg-faint">
        <Folder size={12} aria-hidden="true" />
        Synced folder
      </span>
    );
  }
  if (share.kind === 'server') {
    const host = remoteHost(share.server?.url) ?? 'Wirebench Server';
    return (
      <span data-testid="workspace-picker-share" className="inline-flex items-center gap-1 text-xs text-fg-faint">
        <Server size={12} aria-hidden="true" />
        {share.server?.teamName === undefined ? host : `${host} · ${share.server.teamName}`}
      </span>
    );
  }
  const host = remoteHost(share.remote);
  return (
    <span data-testid="workspace-picker-share" className="inline-flex items-center gap-1 text-xs text-fg-faint">
      <GitBranch size={12} aria-hidden="true" />
      {host ?? 'Shared'}
    </span>
  );
}

/** `2026-09-10T08:30:00Z` as a short local date — precise enough to tell two sessions apart. */
function formatOpenedAt(iso: string | undefined): string {
  if (iso === undefined) {
    return 'Never opened';
  }
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString();
}

/** The last path segment of a folder, whichever separator the platform used. */
function folderName(dir: string): string {
  const parts = dir.split(/[\\/]/).filter((part) => part.length > 0);
  return parts[parts.length - 1] ?? dir;
}

/**
 * What the app shows when no workspace is open: the workspaces on disk (name, project count,
 * last opened), a name field to create another, *Import project folder…*, the folders of a
 * pre-workspace recent list as one-click imports, and — when the workspace reopened at launch
 * would not open — why.
 */
export function WorkspacePicker() {
  const workspaces = useWorkspaceStore((state) => state.workspaces);
  const suggestions = useWorkspaceStore((state) => state.suggestions);
  const status = useWorkspaceStore((state) => state.status);
  const error = useWorkspaceStore((state) => state.error);
  const lastError = useWorkspaceStore((state) => state.lastError);
  const list = useWorkspaceStore((state) => state.list);
  const setJoinDialogOpen = useUiStore((state) => state.setJoinDialogOpen);
  const setTeamWorkspaceDialogOpen = useUiStore((state) => state.setTeamWorkspaceDialogOpen);
  // Shown only once a server is known: without one the app shows no account UI at all.
  const knowsServer = useAccountStore((state) => state.servers.length > 0);
  const [name, setName] = useState('');

  useEffect(() => {
    void list();
  }, [list]);

  const submit = (): void => {
    const trimmed = name.trim();
    if (trimmed.length === 0) {
      return;
    }
    setName('');
    void workspaceActions.create(trimmed);
  };

  // A failed action's error is the newer news; the launch-time failure is shown until then.
  const banner = error?.message ?? lastError;

  return (
    <div data-testid="workspace-picker" className="flex h-full flex-col items-center overflow-auto px-6 py-10">
      <div className="w-full max-w-xl">
        <h1 className="text-lg font-medium text-fg-default">Wirebench</h1>
        <p className="mt-1 text-sm text-fg-subtle">
          A workspace holds your projects and the environments they share. Everything lives in plain files you can read,
          diff and commit.
        </p>

        {banner !== undefined && (
          <p role="alert" className="mt-4 rounded-md border border-status-danger px-3 py-2 text-sm text-status-danger">
            {banner}
          </p>
        )}

        <div className="mt-5 flex flex-wrap items-center gap-2">
          <input
            data-testid="workspace-create-name"
            autoFocus
            aria-label="New workspace name"
            placeholder="Workspace name"
            value={name}
            onChange={(event) => {
              setName(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                submit();
              }
            }}
            className="h-row min-w-64 rounded-md border border-hairline-strong bg-surface-raised px-2 text-md text-fg-default"
          />
          <Button data-testid="workspace-create" variant="primary" disabled={name.trim().length === 0} onClick={submit}>
            <FolderPlus size={14} aria-hidden="true" />
            Create workspace
          </Button>
          <Button
            data-testid="workspace-import-folder"
            onClick={() => {
              void workspaceActions.importProjectFolder();
            }}
          >
            <FolderInput size={14} aria-hidden="true" />
            Import project folder…
          </Button>
          <Button
            data-testid="workspace-join"
            onClick={() => {
              setJoinDialogOpen(true);
            }}
          >
            <GitBranch size={14} aria-hidden="true" />
            Join shared workspace…
          </Button>
          {knowsServer && (
            <Button
              data-testid="workspace-open-team"
              onClick={() => {
                setTeamWorkspaceDialogOpen(true);
              }}
            >
              <Server size={14} aria-hidden="true" />
              Open a team workspace…
            </Button>
          )}
        </div>

        <h2 className="mt-8 text-sm font-medium text-fg-muted">Workspaces</h2>
        {workspaces.length === 0 ? (
          <p className="mt-1 text-sm text-fg-subtle">{status === 'loading' ? 'Loading…' : 'No workspaces yet.'}</p>
        ) : (
          <ul className="mt-1 flex flex-col">
            {workspaces.map((workspace) => {
              const unreadable = workspace.unreadable === true;
              return (
                <li key={workspace.id} className="flex items-center gap-1">
                  <button
                    type="button"
                    data-testid="workspace-picker-row"
                    data-workspace-id={workspace.id}
                    disabled={unreadable}
                    title={unreadable ? `${workspace.dir} (unreadable)` : workspace.dir}
                    onClick={() => {
                      void workspaceActions.open(workspace.id);
                    }}
                    className="flex min-w-0 flex-1 items-baseline gap-2 rounded px-2 py-1 text-left hover:bg-surface-raised disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <span className="shrink-0 text-sm text-fg-default">{workspace.name}</span>
                    {workspace.share !== undefined && <ShareGlyph share={workspace.share} />}
                    <span className="min-w-0 flex-1 truncate font-mono text-xs text-fg-subtle">{workspace.dir}</span>
                    <span className="shrink-0 text-xs text-fg-faint">
                      {unreadable
                        ? 'Cannot be read'
                        : `${String(workspace.projectCount)} project${workspace.projectCount === 1 ? '' : 's'} · ${formatOpenedAt(workspace.lastOpenedAt)}`}
                    </span>
                  </button>
                  {unreadable && (
                    <Button
                      aria-label={`Reveal the folder of ${workspace.name}`}
                      onClick={() => {
                        void workspaceActions.reveal(workspace.id);
                      }}
                    >
                      <FolderSearch size={14} aria-hidden="true" />
                      Reveal
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {suggestions.length > 0 && (
          <>
            <h2 className="mt-8 text-sm font-medium text-fg-muted">Project folders you opened before</h2>
            <p className="mt-1 text-sm text-fg-subtle">Import one to copy it into a workspace.</p>
            <ul className="mt-1 flex flex-col">
              {suggestions.map((dir, index) => (
                <li key={dir}>
                  <button
                    type="button"
                    title={dir}
                    onClick={() => {
                      void workspaceActions.importSuggestion(index);
                    }}
                    className="flex w-full items-baseline gap-2 rounded px-2 py-1 text-left hover:bg-surface-raised"
                  >
                    <span className="shrink-0 text-sm text-fg-default">{folderName(dir)}</span>
                    <span className="min-w-0 flex-1 truncate font-mono text-xs text-fg-subtle">{dir}</span>
                    <span className="shrink-0 text-xs text-accent">Import</span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}
