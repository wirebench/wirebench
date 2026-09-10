import type { ButtonHTMLAttributes } from 'react';
import { Tooltip } from './tooltip.js';

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Accessible name and tooltip text — required, since the button shows only an icon. */
  readonly label: string;
  readonly active?: boolean;
  readonly shortcut?: string | undefined;
}

/** A square icon control with a tooltip standing in for its (visually absent) label. */
export function IconButton({ label, active = false, shortcut, className = '', ...rest }: IconButtonProps) {
  return (
    <Tooltip label={label} shortcut={shortcut}>
      <button
        type="button"
        aria-label={label}
        aria-pressed={active}
        className={`inline-flex size-7 items-center justify-center rounded-md transition-colors ${
          active ? 'bg-surface-active text-accent' : 'text-fg-subtle hover:bg-surface-hover hover:text-fg-default'
        } ${className}`}
        {...rest}
      />
    </Tooltip>
  );
}
