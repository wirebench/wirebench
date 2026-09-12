import { Suspense, lazy } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { IconButton } from '../../components/icon-button.js';
import { useUiStore } from '../../state/ui.js';

/**
 * Loaded on demand, as the Preferences tab used to be: the editor pulls in every section's form
 * (and the shortcuts keymap with them), which is a lot of code for a dialog most sessions never
 * open.
 */
const PreferencesEditor = lazy(async () => {
  const module = await import('./preferences-editor.js');
  return { default: module.PreferencesEditor };
});

/**
 * Settings, as a modal.
 *
 * It used to be a sidebar view *and* an editor tab: the rail opened a list of sections, each of
 * which opened a tab whose own left-hand nav listed the same sections again — two lists, one
 * duplicating the other, and a tab competing with the request the user was working on. A modal
 * has one section list (the editor's own) and hands the editor back when it closes.
 */
export function PreferencesDialog() {
  const open = useUiStore((state) => state.preferences.open);
  const section = useUiStore((state) => state.preferences.section);
  const setOpen = useUiStore((state) => state.setPreferencesOpen);

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/40" />
        <Dialog.Content
          data-testid="preferences-dialog"
          // Sized against the window rather than fixed: the Shortcuts section is a long table,
          // and the forms are wide. `min-h-0` so the editor's own panes get the scrolling.
          className="fixed top-1/2 left-1/2 flex h-[min(40rem,85vh)] w-[min(56rem,90vw)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-lg border border-hairline bg-surface-base shadow-lg"
        >
          <div className="flex h-row shrink-0 items-center justify-between border-b border-hairline px-3">
            <Dialog.Title className="text-md font-medium text-fg-default">Settings</Dialog.Title>
            <Dialog.Close asChild>
              <IconButton label="Close settings" data-testid="preferences-dialog-close">
                <X size={14} aria-hidden="true" />
              </IconButton>
            </Dialog.Close>
          </div>
          {/* Every preference is applied the moment it changes — there is no Save here to
              describe, and no draft to lose by closing. */}
          <Dialog.Description className="sr-only">
            Application preferences. Changes apply immediately.
          </Dialog.Description>
          <div className="flex min-h-0 flex-1 flex-col">
            <Suspense fallback={<p className="p-4 text-sm text-fg-subtle">Loading settings…</p>}>
              {/* Remounted per section so the editor's own `initialSection` state is re-read:
                  opening Settings from a section-specific route must land on that section even
                  when the dialog was last closed somewhere else. */}
              <PreferencesEditor
                key={section ?? 'default'}
                {...(section === undefined ? {} : { initialSection: section })}
              />
            </Suspense>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
