/**
 * The HTTP method badge that precedes a REST request's name in the explorer, in history rows, and
 * in the request editor's breadcrumbs and responses.
 *
 * Compact coloured text aligned to a fixed column, with no bulky filled background, keeping the
 * explorer tree clean and readable. Three tints by what the method does (read, write, delete), so
 * the colour says how much a request changes while the text says which method it is.
 * An optional `variant="chip"` renders the filled pill badge if needed.
 */

/** What a method does, which is what its badge is tinted by: a read, a write, a delete, or none of those. */
export type MethodTint = 'read' | 'write' | 'delete' | 'other';

const METHOD_TINT: Readonly<Record<string, MethodTint>> = {
  GET: 'read',
  HEAD: 'read',
  OPTIONS: 'read',
  POST: 'write',
  PUT: 'write',
  PATCH: 'write',
  DELETE: 'delete',
};

/** The tint of one method, by its uppercased name; a custom method is `other`. */
export function methodTint(method: string): MethodTint {
  return METHOD_TINT[method.toUpperCase()] ?? 'other';
}

const TINT_TEXT_CLASS: Readonly<Record<MethodTint, string>> = {
  read: 'text-method-read',
  write: 'text-method-write',
  delete: 'text-method-delete',
  other: 'text-method-other',
};

const TINT_CHIP_CLASS: Readonly<Record<MethodTint, string>> = {
  read: 'bg-method-read',
  write: 'bg-method-write',
  delete: 'bg-method-delete',
  other: 'bg-method-other',
};

/** How much of a custom method the badge shows before it is cut short. */
const MAX_LABEL = 7;

/**
 * The short forms the explorer's narrow method column uses, so a name never starts three
 * characters further right on a DELETE row than on a GET row. The row's title still carries the
 * method in full, as does `data-method`.
 */
const SHORT_LABEL: Readonly<Record<string, string>> = {
  DELETE: 'DEL',
  OPTIONS: 'OPT',
  CONNECT: 'CON',
  PATCH: 'PAT',
};

/** The longest label the compact column shows before it is cut short. */
const MAX_COMPACT_LABEL = 4;

/**
 * The compact badge is as wide as its longest label, left-aligned: GET, POST and DEL then all start in
 * one column, where a badge as wide as its own text, right-aligned in the gutter, started POST a
 * character left of GET.
 */
const COMPACT_CLASS = 'inline-block w-[4ch] text-left text-2xs';

/** One method as the compact column spells it: `DELETE` is `DEL`, `GET` and `PATCH` unchanged. */
export function compactMethodLabel(method: string): string {
  const label = method.toUpperCase();
  const short = SHORT_LABEL[label];
  if (short !== undefined) return short;
  return label.length > MAX_COMPACT_LABEL ? `${label.slice(0, 3)}…` : label;
}

export interface MethodBadgeProps {
  readonly method: string;
  /** Adds the method to the accessible name, for a row whose text alone would not carry it. */
  readonly title?: string;
  readonly className?: string;
  /** Visual variant: 'text' (coloured text, default) or 'chip' (filled pill). */
  readonly variant?: 'text' | 'chip';
  /** Spells long methods short, for the explorer's fixed-width method column. */
  readonly compact?: boolean;
}

/** The colour class for one method, exported so the tests can pin the mapping without the DOM. */
export function methodColorClass(method: string): string {
  return TINT_TEXT_CLASS[methodTint(method)];
}

/** The chip background class for one method. */
export function methodChipClass(method: string): string {
  return TINT_CHIP_CLASS[methodTint(method)];
}

/** One method badge. */
export function MethodBadge({ method, title, className, variant = 'text', compact = false }: MethodBadgeProps) {
  const label = method.toUpperCase();
  const truncatedLabel = compact
    ? compactMethodLabel(label)
    : label.length > MAX_LABEL
      ? `${label.slice(0, MAX_LABEL)}…`
      : label;

  if (variant === 'chip') {
    return (
      <span
        data-testid="method-badge"
        data-method={label}
        data-tint={methodTint(method)}
        {...(title !== undefined ? { title } : {})}
        className={`shrink-0 rounded px-1 font-mono text-xs leading-tight text-fg-on-accent ${methodChipClass(method)} ${className ?? ''}`}
      >
        {truncatedLabel}
      </span>
    );
  }

  return (
    <span
      data-testid="method-badge"
      data-method={label}
      data-tint={methodTint(method)}
      {...(title !== undefined ? { title } : {})}
      className={`shrink-0 font-mono ${compact ? COMPACT_CLASS : 'text-xs'} font-bold leading-none ${methodColorClass(method)} ${className ?? ''}`}
    >
      {truncatedLabel}
    </span>
  );
}
