import { useState } from 'react';
import { useProjectStore } from '../../state/project.js';
import { projectActions } from '../welcome/project-actions.js';

/**
 * Non-modal notice that the project folder changed underneath the app (an editor, a `git
 * checkout`, a sync client). Reloading is destructive when there are unsaved edits, so that
 * case asks first; otherwise Reload just re-reads the folder.
 */
export function ChangedOnDiskBanner() {
  const paths = useProjectStore((state) => state.changedOnDisk);
  const dirty = useProjectStore((state) => state.project?.dirty ?? false);
  const dismiss = useProjectStore((state) => state.dismissChangedOnDisk);
  const [confirming, setConfirming] = useState(false);

  if (paths.length === 0) {
    return null;
  }

  const reload = (): void => {
    setConfirming(false);
    void projectActions.reload();
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
          : 'Project files changed on disk — reload to pick them up.'}
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
          dismiss();
        }}
        className="shrink-0 rounded px-2 py-0.5 text-xs text-fg-subtle hover:bg-surface-raised"
      >
        Ignore
      </button>
    </div>
  );
}
