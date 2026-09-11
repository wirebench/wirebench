import { useEffect, useState } from 'react';
import { FolderPlus } from 'lucide-react';
import { Button } from '../../components/button.js';
import { showToast } from '../../components/toast.js';
import { useWorkspaceStore } from '../../state/workspace.js';

/** `2026-09-10T08:30:00Z` as a short local date — precise enough to tell two sessions apart. */
function formatOpenedAt(iso: string | undefined): string {
  if (iso === undefined) {
    return 'Never opened';
  }
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString();
}

/**
 * What the app shows before a workspace is open: the workspaces on disk, and a name field to
 * make another. Deliberately the minimum that lets the rest of the shell assume a workspace —
 * the full picker (rename, delete, import, the leftover-project suggestions) is a later task.
 */
export function WorkspacePicker() {
  const workspaces = useWorkspaceStore((state) => state.workspaces);
  const status = useWorkspaceStore((state) => state.status);
  const error = useWorkspaceStore((state) => state.error);
  const list = useWorkspaceStore((state) => state.list);
  const create = useWorkspaceStore((state) => state.create);
  const open = useWorkspaceStore((state) => state.open);
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
    void create(trimmed).catch((cause: unknown) => {
      showToast(cause instanceof Error ? cause.message : 'Could not create the workspace');
    });
  };

  return (
    <div data-testid="workspace-picker" className="flex h-full flex-col items-center overflow-auto px-6 py-10">
      <div className="w-full max-w-xl">
        <h1 className="text-lg font-medium text-fg-default">Wirebench</h1>
        <p className="mt-1 text-sm text-fg-subtle">
          A workspace holds your projects and the environments they share. Everything lives in plain files you can read,
          diff and commit.
        </p>

        <div className="mt-5 flex flex-wrap items-center gap-2">
          <input
            data-testid="workspace-create-name"
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
        </div>

        <h2 className="mt-8 text-sm font-medium text-fg-muted">Workspaces</h2>
        {error !== undefined && (
          <p role="alert" className="mt-1 text-sm text-status-danger">
            {error.message}
          </p>
        )}
        {workspaces.length === 0 ? (
          <p className="mt-1 text-sm text-fg-subtle">{status === 'loading' ? 'Loading…' : 'No workspaces yet.'}</p>
        ) : (
          <ul className="mt-1 flex flex-col">
            {workspaces.map((workspace) => (
              <li key={workspace.id}>
                <button
                  type="button"
                  data-testid="workspace-picker-row"
                  data-workspace-id={workspace.id}
                  disabled={workspace.unreadable === true}
                  title={workspace.unreadable === true ? `${workspace.dir} (unreadable)` : workspace.dir}
                  onClick={() => {
                    void open(workspace.id).catch((cause: unknown) => {
                      showToast(cause instanceof Error ? cause.message : 'Could not open the workspace');
                    });
                  }}
                  className="flex w-full items-baseline gap-2 rounded px-2 py-1 text-left hover:bg-surface-raised disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <span className="shrink-0 text-sm text-fg-default">{workspace.name}</span>
                  <span className="min-w-0 flex-1 truncate font-mono text-xs text-fg-subtle">{workspace.dir}</span>
                  <span className="shrink-0 text-xs text-fg-faint">
                    {workspace.projectCount} project{workspace.projectCount === 1 ? '' : 's'} ·{' '}
                    {formatOpenedAt(workspace.lastOpenedAt)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
