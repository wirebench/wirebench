import { formatClockTime } from '../../lib/format-size.js';
import { useProjectStore } from '../../state/project.js';

/**
 * Whether one project's edits have reached disk, said where the editing happens.
 *
 * The app autosaves, so the useful thing to show is not a warning but a confirmation: an edit
 * flips this to *Unsaved changes*, and roughly half a second later the autosave lands and it
 * settles on *Saved HH:MM*, which then stays. Without it the only feedback was a dot in the
 * title bar that appears and disappears inside that same half second, and a line at the far
 * corner of the status strip — neither of them anywhere near the field being edited.
 */
export function SaveIndicator({ projectId }: { readonly projectId: string }) {
  const dirty = useProjectStore((state) => state.projects[projectId]?.dirty ?? false);
  const lastSavedAt = useProjectStore((state) => state.projects[projectId]?.lastSavedAt);
  // Only the explicit save (⌘S) reports its own progress; the autosave runs in main and is seen
  // here as `dirty` going false with a newer `lastSavedAt`.
  const saving = useProjectStore((state) => state.saveStatus[projectId] === 'saving');

  if (!dirty && !saving && lastSavedAt === undefined) {
    // Nothing has been edited or written this session: an indicator would have nothing to say.
    return null;
  }

  const pending = dirty || saving;
  const label = saving ? 'Saving…' : dirty ? 'Unsaved changes' : `Saved ${formatClockTime(lastSavedAt ?? '')}`;

  return (
    <p
      data-testid="project-save-indicator"
      data-pending={pending}
      // `polite`, not `assertive`: this reports on work the user already did, so it must wait
      // its turn rather than interrupt whatever they are typing next.
      aria-live="polite"
      className={`flex items-center gap-1.5 text-xs ${pending ? 'text-status-warning' : 'text-fg-subtle'}`}
    >
      <span aria-hidden="true" className={`size-1.5 rounded-full ${pending ? 'bg-status-warning' : 'bg-fg-faint'}`} />
      {label}
    </p>
  );
}
