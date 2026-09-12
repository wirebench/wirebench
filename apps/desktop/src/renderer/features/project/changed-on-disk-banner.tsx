import { useState } from 'react';
import { useProjectStore } from '../../state/project.js';
import { projectActions } from './project-actions.js';

/**
 * Non-modal notice that a project folder changed underneath the app (an editor, a `git
 * checkout`, a sync client). Reloading is destructive when there are unsaved edits, so that
 * case asks first; otherwise Reload just re-reads the folder.
 *
 * One banner per project with pending paths, each naming its project: several projects are
 * open at once, the watcher reports per project, and reloading one must not discard another's
 * unsaved edits. The first banner keeps the `changed-on-disk-banner` / `changed-on-disk-reload`
 * test ids so a single-project scenario reads exactly as it did before.
 */
function ProjectBanner({ projectId, paths, first }: { projectId: string; paths: readonly string[]; first: boolean }) {
  const name = useProjectStore((state) => state.projects[projectId]?.name) ?? 'Project';
  const dirty = useProjectStore((state) => state.projects[projectId]?.dirty) ?? false;
  const dismiss = useProjectStore((state) => state.dismissChangedOnDisk);
  const [confirming, setConfirming] = useState(false);

  const reload = (): void => {
    setConfirming(false);
    void projectActions.reload(projectId);
  };

  const suffix = first ? '' : `-${projectId}`;

  return (
    <div
      role="status"
      data-testid={`changed-on-disk-banner${suffix}`}
      data-project-id={projectId}
      className="flex shrink-0 items-center gap-3 border-b border-hairline bg-surface-sunken px-3 py-1.5 text-sm text-fg-default"
    >
      <span className="min-w-0 flex-1 truncate" title={paths.join('\n')}>
        {confirming
          ? `Reloading ${name} discards your unsaved changes. Continue?`
          : `${name}: ${String(paths.length)} ${paths.length === 1 ? 'file' : 'files'} changed on disk — reload to pick them up.`}
      </span>
      <button
        type="button"
        data-testid={`changed-on-disk-reload${suffix}`}
        onClick={() => (dirty && !confirming ? setConfirming(true) : reload())}
        className="shrink-0 rounded border border-hairline-strong px-2 py-0.5 text-xs hover:bg-surface-raised"
      >
        {confirming ? 'Discard and reload' : 'Reload'}
      </button>
      <button
        type="button"
        data-testid={`changed-on-disk-ignore${suffix}`}
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

/** One {@link ProjectBanner} per open project the watcher has pending paths for. */
export function ChangedOnDiskBanner() {
  const changedOnDisk = useProjectStore((state) => state.changedOnDisk);
  const order = useProjectStore((state) => state.order);

  // Banner order follows the explorer's project order, so the one that keeps the stable test
  // ids does not depend on which watcher happened to fire first.
  const ranked = new Map(order.map((entry, index) => [entry.projectId, index]));
  const pending = Object.entries(changedOnDisk)
    .filter(([, paths]) => paths.length > 0)
    .sort(([a], [b]) => (ranked.get(a) ?? Number.MAX_SAFE_INTEGER) - (ranked.get(b) ?? Number.MAX_SAFE_INTEGER));
  if (pending.length === 0) {
    return null;
  }

  return (
    <>
      {pending.map(([projectId, paths], index) => (
        <ProjectBanner key={projectId} projectId={projectId} paths={paths} first={index === 0} />
      ))}
    </>
  );
}
