import type { ReactElement, ReactNode } from 'react';
import * as RadixTooltip from '@radix-ui/react-tooltip';

export interface TooltipProps {
  readonly label: string;
  readonly shortcut?: string | undefined;
  readonly side?: 'top' | 'right' | 'bottom' | 'left';
  readonly children: ReactElement;
}

/** Wraps the shell's tooltip styling; the trigger keeps its own accessible name. */
export function Tooltip({ label, shortcut, side = 'bottom', children }: TooltipProps): ReactNode {
  return (
    <RadixTooltip.Root>
      <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
      <RadixTooltip.Portal>
        <RadixTooltip.Content
          side={side}
          sideOffset={6}
          className="z-50 flex items-center gap-2 rounded-md border border-hairline bg-surface-overlay px-2 py-1 text-sm text-fg-default shadow-lg"
        >
          {label}
          {shortcut !== undefined && <span className="font-mono text-xs text-fg-subtle">{shortcut}</span>}
        </RadixTooltip.Content>
      </RadixTooltip.Portal>
    </RadixTooltip.Root>
  );
}
