import type { ButtonHTMLAttributes } from 'react';

type Variant = 'primary' | 'secondary' | 'ghost';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: Variant;
}

const VARIANTS: Readonly<Record<Variant, string>> = {
  primary: 'bg-accent text-fg-on-accent hover:bg-accent-hover border-transparent',
  secondary: 'bg-surface-raised text-fg-default hover:bg-surface-hover border-hairline-strong',
  ghost: 'bg-transparent text-fg-muted hover:bg-surface-hover hover:text-fg-default border-transparent',
};

/** The classes a button takes when a ▾ is joined to its right, as one split button. */
export const SPLIT_HEAD_CLASS = 'rounded-r-none';

/** The classes the ▾ of a split button takes, joined to the button on its left. */
export const SPLIT_TAIL_CLASS = 'rounded-l-none border-l border-l-black/20 px-1.5';

/** The shell's only button. Compact by default (26px), keyboard reachable, accent focus ring. */
export function Button({ variant = 'secondary', className = '', type = 'button', ...rest }: ButtonProps) {
  return (
    <button
      type={type}
      className={`inline-flex h-row items-center gap-2 rounded-md border px-3 text-md whitespace-nowrap transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${VARIANTS[variant]} ${className}`}
      {...rest}
    />
  );
}
