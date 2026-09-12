import { useMemo } from 'react';
import { formatClockTime } from '../../lib/format-size.js';
import { shortcutFor } from '../../lib/keybindings.js';
import { detectPlatform } from '../../lib/platform.js';
import { useProjectStore } from '../../state/project.js';

/**
 * Whether one project's edits have reached disk, said where the editing happens.
 *
 * Saving is manual unless the user turns autosave on, so *Unsaved changes* is a standing state
 * rather than a flicker, and the control that clears it has to be nameable: the chord is read
 * from the live keymap, since the user can rebind it. With autosave on the same indicator
 * settles on *Saved HH:MM* a moment later by itself.
 */
export function SaveIndicator({ projectId }: { readonly projectId: string }) {
  // Read once per mount: the platform never changes, and the keymap is read through the same
  // store the Shortcuts editor writes, so a rebind is picked up on the next render.
  const platform = useMemo(() => detectPlatform(), []);
  const saveShortcut = shortcutFor('project.save', platform);
  const saveHint = saveShortcut === undefined ? 'Save to write these to disk' : `Save all (${saveShortcut})`;

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
  const hint = dirty && !saving ? saveHint : undefined;

  return (
    <p
      data-testid="project-save-indicator"
      data-pending={pending}
      {...(hint === undefined ? {} : { title: hint })}
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
