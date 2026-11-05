/**
 * The pieces every card of the *Server* page is made of (hosted edition spec §22.13): a card with a title, a state
 * chip and a footer of actions; a labelled field row; a secret that is never shown, as a *Set* chip and *Replace…*;
 * and the read-only form a self-hosted server's environment-backed section takes, naming each variable.
 */
import { useState, type ReactNode } from 'react';
import { Button } from '../../../components/button.js';

/** The look of the page's text controls: the Settings page's inputs. */
export const INPUT =
  'h-row w-full min-w-0 rounded-md border border-hairline-strong bg-surface-base px-2 text-sm text-fg-default placeholder:text-fg-faint focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-60';
export const MONO_INPUT = `${INPUT} font-mono text-xs`;
export const TEXTAREA =
  'w-full min-w-0 rounded-md border border-hairline-strong bg-surface-base px-2 py-1.5 font-mono text-xs text-fg-default placeholder:text-fg-faint focus:outline-none focus:ring-1 focus:ring-accent';

export type ChipTone = 'ok' | 'neutral' | 'warning' | 'danger';

const CHIP_TONES: Readonly<Record<ChipTone, string>> = {
  ok: 'bg-status-success/15 text-status-success',
  neutral: 'bg-surface-hover text-fg-subtle',
  warning: 'bg-status-warning/10 text-status-warning',
  danger: 'bg-status-danger/15 text-status-danger',
};

export function Chip({
  tone = 'neutral',
  children,
  testId,
}: {
  readonly tone?: ChipTone;
  readonly children: ReactNode;
  readonly testId?: string;
}) {
  return (
    <span
      {...(testId === undefined ? {} : { 'data-testid': testId })}
      className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-2xs ${CHIP_TONES[tone]}`}
    >
      {children}
    </span>
  );
}

/** A card: its title and chip, its rows, and a footer of actions when it has any. */
export function ServerCard({
  title,
  chip,
  children,
  footer,
  testId,
  danger = false,
}: {
  readonly title: string;
  readonly chip?: ReactNode;
  readonly children: ReactNode;
  readonly footer?: ReactNode;
  readonly testId: string;
  readonly danger?: boolean;
}) {
  const id = `${testId}-title`;
  return (
    <section
      aria-labelledby={id}
      data-testid={testId}
      className={`mt-5 flex flex-col overflow-hidden rounded-lg border bg-surface-raised first:mt-0 ${danger ? 'border-status-danger/40' : 'border-hairline'}`}
    >
      <div className="flex items-center gap-3 border-b border-hairline px-4 py-3">
        <h2 id={id} className="flex-1 text-sm font-semibold text-fg-default">
          {title}
        </h2>
        {chip}
      </div>
      <div className="px-4 py-4">{children}</div>
      {footer !== undefined && (
        <div className="flex items-center justify-end gap-2 border-t border-hairline px-4 py-3">{footer}</div>
      )}
    </section>
  );
}

/** A grid of label and control, as the mockup lays a card's fields out. */
export function FieldGrid({ children }: { readonly children: ReactNode }) {
  return <div className="grid grid-cols-[180px_minmax(0,1fr)] items-center gap-x-4 gap-y-3 text-sm">{children}</div>;
}

export function FieldLabel({ htmlFor, children }: { readonly htmlFor?: string; readonly children: ReactNode }) {
  return htmlFor === undefined ? (
    <span className="text-fg-subtle">{children}</span>
  ) : (
    <label htmlFor={htmlFor} className="text-fg-subtle">
      {children}
    </label>
  );
}

/**
 * A stored secret: a *Set* or *Not set* chip, and *Replace…*, which opens a field for a new value. The stored value is
 * never shown, and the typed one leaves with the save.
 */
export function SecretField({
  id,
  label,
  set,
  value,
  onChange,
  disabled = false,
}: {
  readonly id: string;
  readonly label: string;
  readonly set: boolean;
  /** `undefined` while the stored one is kept. */
  readonly value: string | undefined;
  readonly onChange: (value: string | undefined) => void;
  readonly disabled?: boolean;
}) {
  if (value !== undefined) {
    return (
      <div className="flex items-center gap-2">
        <input
          id={id}
          data-testid={`${id}-input`}
          type="password"
          autoComplete="off"
          aria-label={label}
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
          className={MONO_INPUT}
        />
        {set && (
          <Button variant="ghost" data-testid={`${id}-keep`} onClick={() => onChange(undefined)}>
            Keep current
          </Button>
        )}
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2.5">
      <Chip testId={`${id}-state`}>{set ? 'Set' : 'Not set'}</Chip>
      <Button data-testid={`${id}-replace`} disabled={disabled} onClick={() => onChange('')}>
        {set ? 'Replace…' : 'Set…'}
      </Button>
      <span className="text-xs text-fg-faint">Never shown again once saved</span>
    </div>
  );
}

/** A value the page shows but does not edit: a URL to give an identity provider, with Copy. */
export function CopyValue({ value, testId }: { readonly value: string; readonly testId: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex min-w-0 items-center gap-2">
      <code data-testid={testId} className="min-w-0 truncate font-mono text-xs text-fg-default">
        {value}
      </code>
      <Button
        variant="ghost"
        data-testid={`${testId}-copy`}
        onClick={() => {
          void navigator.clipboard.writeText(value).then(() => setCopied(true));
        }}
      >
        {copied ? 'Copied' : 'Copy'}
      </Button>
    </div>
  );
}

/** The card's own error line, in the server's words. */
export function CardError({ error, testId }: { readonly error: string | undefined; readonly testId: string }) {
  if (error === undefined) return null;
  return (
    <p role="alert" data-testid={testId} className="mt-3 text-sm text-status-danger">
      {error}
    </p>
  );
}

/** One environment-backed field of a self-hosted server: its value (or *Not set*) and the variable that sets it. */
export interface EnvironmentRow {
  readonly label: string;
  readonly variable: string;
  /** `undefined`: not set. A secret's value is only `Set`. */
  readonly value: string | undefined;
  readonly secret?: boolean;
}

/**
 * A self-hosted server's section (spec §22.13): read-only, with "Set by the server's environment", each field naming
 * the variable that sets it, as the server's `settings-environment` answer says to change it there.
 */
export function EnvironmentCard({
  title,
  rows,
  set,
  testId,
}: {
  readonly title: string;
  readonly rows: readonly EnvironmentRow[];
  /** Whether the section is set at all. */
  readonly set: boolean;
  readonly testId: string;
}) {
  return (
    <ServerCard
      title={title}
      testId={testId}
      chip={<Chip testId={`${testId}-state`}>{set ? 'Set by the server’s environment' : 'Not set'}</Chip>}
    >
      <div className="grid grid-cols-[180px_minmax(0,1fr)_minmax(0,1fr)] items-center gap-x-4 gap-y-2.5 text-sm">
        <span />
        <span className="text-xs text-fg-faint">Value</span>
        <span className="text-xs text-fg-faint">Variable</span>
        {rows.map((row) => (
          <EnvironmentRowView key={row.variable} row={row} />
        ))}
      </div>
    </ServerCard>
  );
}

function EnvironmentRowView({ row }: { readonly row: EnvironmentRow }) {
  return (
    <>
      <span className="text-fg-subtle">{row.label}</span>
      {row.value === undefined ? (
        <span className="text-fg-faint">Not set</span>
      ) : row.secret === true ? (
        <span>
          <Chip>Set</Chip>
        </span>
      ) : (
        <code className="min-w-0 truncate font-mono text-xs text-fg-default">{row.value}</code>
      )}
      <code className="min-w-0 truncate font-mono text-xs text-fg-subtle">{row.variable}</code>
    </>
  );
}

type View = Readonly<Record<string, unknown>> | null | undefined;

/** A field of a section's view as text, or `undefined` when absent; arrays joined with spaces. */
export function fieldText(value: View, key: string): string | undefined {
  const field = value?.[key];
  if (field === undefined || field === null) return undefined;
  if (Array.isArray(field)) return field.join(' ');
  if (typeof field === 'string') return field;
  if (typeof field === 'number' || typeof field === 'boolean') return String(field);
  return undefined;
}

/** Whether a secret of a section's view is stored: the server answers `{ set: true }`, never the value. */
export function secretSet(value: View, key: string): boolean {
  const field = value?.[key] as { readonly set?: unknown } | undefined;
  return field?.set === true;
}

/** A secret of an environment-backed view, as an {@link EnvironmentRow}'s value. */
export function secretText(value: View, key: string): string | undefined {
  return secretSet(value, key) ? 'set' : undefined;
}

/** The Remove and *Check and save* buttons a writable section's footer holds. */
export function SaveFooter({
  testId,
  busy,
  canRemove,
  onRemove,
  onSave,
  saveDisabled = false,
}: {
  readonly testId: string;
  readonly busy: boolean;
  readonly canRemove: boolean;
  readonly onRemove: () => void;
  readonly onSave: () => void;
  readonly saveDisabled?: boolean;
}) {
  return (
    <>
      {canRemove && (
        <Button
          variant="ghost"
          data-testid={`${testId}-remove`}
          disabled={busy}
          onClick={onRemove}
          className="text-status-danger"
        >
          Remove
        </Button>
      )}
      <Button variant="primary" data-testid={`${testId}-save`} disabled={busy || saveDisabled} onClick={onSave}>
        {busy ? 'Checking…' : 'Check and save'}
      </Button>
    </>
  );
}
