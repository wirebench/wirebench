/** The toolbar's dropdown menus (Recreate, Copy as cURL), split out to keep `toolbar.tsx` small. */

import type { ReactNode } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { ChevronDown } from 'lucide-react';

const ITEM_CLASS =
  'flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm text-fg-default outline-none data-[highlighted]:bg-accent-muted';

export interface ToolbarMenuItem {
  readonly label: string;
  readonly onSelect: () => void;
}

export interface ToolbarMenuProps {
  /** The button's own label; clicking it runs {@link ToolbarMenuProps.onPrimary}. */
  readonly label: string;
  readonly ariaLabel: string;
  readonly testId: string;
  /** The default action, run when the button (rather than its arrow) is clicked. */
  readonly onPrimary: () => void;
  readonly items: readonly ToolbarMenuItem[];
  readonly disabled?: boolean;
}

/**
 * A split button: the label runs the default action, the caret opens the rest. Both halves are
 * real buttons, so the whole control is reachable and operable from the keyboard.
 */
export function ToolbarMenu({ label, ariaLabel, testId, onPrimary, items, disabled }: ToolbarMenuProps): ReactNode {
  return (
    <div className="flex shrink-0 items-center">
      <button
        type="button"
        data-testid={testId}
        disabled={disabled}
        onClick={onPrimary}
        className="h-row rounded-l-md border border-hairline-strong bg-surface-raised px-2 text-sm text-fg-default hover:bg-surface-hover disabled:opacity-50"
      >
        {label}
      </button>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button
            type="button"
            aria-label={ariaLabel}
            data-testid={`${testId}-menu`}
            disabled={disabled}
            className="h-row rounded-r-md border border-l-0 border-hairline-strong bg-surface-raised px-1 text-fg-subtle hover:bg-surface-hover hover:text-fg-default disabled:opacity-50"
          >
            <ChevronDown size={12} aria-hidden="true" />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            side="bottom"
            align="start"
            sideOffset={4}
            className="min-w-56 rounded-md border border-hairline bg-surface-raised p-1 shadow-lg"
          >
            {items.map((item) => (
              <DropdownMenu.Item key={item.label} className={ITEM_CLASS} onSelect={item.onSelect}>
                {item.label}
              </DropdownMenu.Item>
            ))}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </div>
  );
}
