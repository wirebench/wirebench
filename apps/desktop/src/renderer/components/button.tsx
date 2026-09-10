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
