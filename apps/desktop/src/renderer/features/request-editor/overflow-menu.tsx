import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Check, MoreHorizontal } from 'lucide-react';
import { getActiveRequestEditor, getActiveRequestPaneHandle } from '../../editor/active-request-editor.js';
import { loadXmlFrom, saveXmlAs } from '../../editor/xml-file-ops.js';
import { gotoLine } from '../../editor/xml-language.js';
import { useUiStore } from '../../state/ui.js';

const ITEM_CLASS =
  'flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm text-fg-default outline-none data-[highlighted]:bg-accent-muted';

export interface OverflowMenuProps {
  /** Called after Load from… replaces the buffer, so the pane can sync its local + store state. */
  readonly onLoaded: (envelopeXml: string) => void;
  readonly currentText: string;
}

/**
 * The request editor's "⋯" overflow menu: Format, Go to line, Line numbers, Save as…, Load
 * from…. Every action reaches the currently mounted Monaco instance via
 * `active-request-editor.ts` rather than a prop, since the menu lives in the view-tabs strip,
 * a sibling of the editor rather than an ancestor.
 */
export function OverflowMenu({ onLoaded, currentText }: OverflowMenuProps) {
  const lineNumbers = useUiStore((state) => state.editorLineNumbers);
  const toggleLineNumbers = useUiStore((state) => state.toggleEditorLineNumbers);

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          aria-label="More request editor actions"
          data-testid="request-editor-overflow"
          className="inline-flex items-center rounded px-1.5 py-1 text-fg-subtle hover:bg-surface-hover hover:text-fg-default"
        >
          <MoreHorizontal size={14} aria-hidden="true" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          side="bottom"
          align="end"
          sideOffset={4}
          className="min-w-48 rounded-md border border-hairline bg-surface-raised p-1 shadow-lg"
        >
          <DropdownMenu.Item
            className={ITEM_CLASS}
            onSelect={() => {
              const handle = getActiveRequestPaneHandle();
              if (handle !== undefined) {
                handle.formatAndCommit();
              }
            }}
          >
            Format
          </DropdownMenu.Item>
          <DropdownMenu.Item
            className={ITEM_CLASS}
            onSelect={() => {
              const editor = getActiveRequestEditor();
              if (editor !== undefined) {
                gotoLine(editor);
              }
            }}
          >
            Go to line…
          </DropdownMenu.Item>
          <DropdownMenu.Item
            className={ITEM_CLASS}
            onSelect={(event) => {
              event.preventDefault();
              toggleLineNumbers();
            }}
          >
            <span className="w-4">{lineNumbers ? <Check size={14} aria-hidden="true" /> : null}</span>
            Line numbers
          </DropdownMenu.Item>
          <DropdownMenu.Separator className="my-1 h-px bg-hairline" />
          <DropdownMenu.Item
            className={ITEM_CLASS}
            onSelect={() => {
              void saveXmlAs(currentText);
            }}
          >
            Save as…
          </DropdownMenu.Item>
          <DropdownMenu.Item
            className={ITEM_CLASS}
            onSelect={() => {
              void loadXmlFrom(currentText).then((text) => {
                if (text !== undefined) {
                  onLoaded(text);
                }
              });
            }}
          >
            Load from…
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
