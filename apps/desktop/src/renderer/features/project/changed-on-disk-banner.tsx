import { useState } from 'react';
import { useProjectStore } from '../../state/project.js';
import { projectActions } from './project-actions.js';

/**
 * Non-modal notice that a project folder changed underneath the app (an editor, a `git
 * checkout`, a sync client). Reloading is destructive when there are unsaved edits, so that
 * case asks first; otherwise Reload just re-reads the folder.
 *
 * Keyed by project: the watcher reports per project, and reloading one must not discard
 * another's unsaved edits. The banner shows the first project with pending paths; dismissing
 * or reloading it reveals the next.
 */
export function ChangedOnDiskBanner() {
  const changedOnDisk = useProjectStore((state) => state.changedOnDisk);
  const projects = useProjectStore((state) => state.projects);
  const dismiss = useProjectStore((state) => state.dismissChangedOnDisk);
  const [confirming, setConfirming] = useState(false);

  const entry = Object.entries(changedOnDisk).find(([, list]) => list.length > 0);
  if (entry === undefined) {
    return null;
  }
  const [projectId, paths] = entry;
  const dirty = projects[projectId]?.dirty ?? false;

  const reload = (): void => {
    setConfirming(false);
    void projectActions.reload(projectId);
  };

  return (
    <div
      role="status"
      data-testid="changed-on-disk-banner"
      className="flex shrink-0 items-center gap-3 border-b border-hairline bg-surface-sunken px-3 py-1.5 text-sm text-fg-default"
    >
      <span className="min-w-0 flex-1 truncate" title={paths.join('\n')}>
        {confirming
          ? 'Reloading discards your unsaved changes. Continue?'
          : `${projects[projectId]?.name ?? 'Project'} files changed on disk — reload to pick them up.`}
      </span>
      <button
        type="button"
        data-testid="changed-on-disk-reload"
        onClick={() => (dirty && !confirming ? setConfirming(true) : reload())}
        className="shrink-0 rounded border border-hairline-strong px-2 py-0.5 text-xs hover:bg-surface-raised"
      >
        {confirming ? 'Discard and reload' : 'Reload'}
      </button>
      <button
        type="button"
        data-testid="changed-on-disk-ignore"
        onClick={() => {
          setConfirming(false);
          dismiss(projectId);
        }}
        className="shrink-0 rounded px-2 py-0.5 text-xs text-fg-subtle hover:bg-surface-raised"
      >
        Ignore
      </button>
    </div>
  );
}
