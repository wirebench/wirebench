import { createContext, useContext, useEffect, useId, useState } from 'react';

/**
 * The rows every settings surface uses — the Details panel's request/interface/endpoint
 * properties, the per-request Settings tabs, and each section of the Settings page.
 *
 * Two variants share one set of components:
 *
 * - `compact` (the default) is the dense "name | editor" grid the Details panel and editor tabs
 *   want: a 26px row, the label on the left, the control filling the rest, a hint as a tooltip.
 * - `card` is the Settings page: each group is a rounded card of hairline-separated rows, the
 *   hint shows under the label, the control sits right-aligned, booleans are switches and short
 *   enums are segmented controls. A surface opts in with {@link SettingsVariantProvider}.
 *
 * Text and number fields commit on blur or Enter (Escape reverts), so a keystroke is never a
 * mutation; switches, checkboxes, segmented controls and selects commit immediately, because
 * there is nothing to revert to. A field whose draft breaks its rule says so under the row as it
 * is typed (`aria-invalid`, a danger border, the rule in words) and is never committed — nor
 * silently snapped back: the draft stays for the user to fix, until Escape reverts it. Every row's label is a real `<label>` bound to its control,
 * which is what makes the rows keyboard- and screen-reader-navigable without extra ARIA.
 *
 * A row that names its preference (`setting`, a dotted key such as `proxy.mode`) can also show
 * whether it differs from its default and offer a per-row Reset, when a surface supplies a
 * {@link SettingsRowsController}. Without one — the Details panel — `setting` is inert.
 */

export type SettingsVariant = 'compact' | 'card';

const VariantContext = createContext<SettingsVariant>('compact');

/** Switches every settings row below it to `variant`. */
export function SettingsVariantProvider({
  variant,
  children,
}: {
  readonly variant: SettingsVariant;
  readonly children: React.ReactNode;
}) {
  return <VariantContext.Provider value={variant}>{children}</VariantContext.Provider>;
}

/**
 * What a surface tells its rows about the preferences behind them, keyed by dotted preference
 * key. The Settings page provides one; nothing else needs to.
 */
export interface SettingsRowsController {
  /** Whether the stored value differs from the built-in default. */
  readonly isModified: (key: string) => boolean;
  /** Whether {@link reset} can restore this key on its own (a few keys can only be cleared elsewhere). */
  readonly canReset: (key: string) => boolean;
  /** Restores one key to its default. */
  readonly reset: (key: string) => void;
  /** Whether a managed-preferences policy locks the key. */
  readonly locked: (key: string) => boolean;
}

const ControllerContext = createContext<SettingsRowsController | undefined>(undefined);

/** Supplies the modified/reset/locked answers to every row below it that names a `setting`. */
export function SettingsRowsControllerProvider({
  controller,
  children,
}: {
  readonly controller: SettingsRowsController;
  readonly children: React.ReactNode;
}) {
  return <ControllerContext.Provider value={controller}>{children}</ControllerContext.Provider>;
}

/**
 * A search across settings. While one is in force, rows that do not match render nothing, groups
 * drop their headings and cards (the search results are one flat list), and each row shows
 * `crumb` — where it lives — above its label.
 */
export interface SettingsSearch {
  /** Lower-cased, trimmed, non-empty. */
  readonly query: string;
  /** "Group › Section", shown above each matching row. */
  readonly crumb: string;
  /** The section's own name, which every row in it matches on. */
  readonly section: string;
  /** The section's other words ("ssh" for Terminal), matched like its name. */
  readonly keywords?: readonly string[];
}

const SearchContext = createContext<SettingsSearch | undefined>(undefined);
const GroupTitleContext = createContext<string | undefined>(undefined);

/** Puts every row below it into search mode; see {@link SettingsSearch}. */
export function SettingsSearchProvider({
  search,
  children,
}: {
  readonly search: SettingsSearch;
  readonly children: React.ReactNode;
}) {
  return <SearchContext.Provider value={search}>{children}</SearchContext.Provider>;
}

/** Whether `query` hits any of a row's label, hint, group title or section name. */
export function settingMatches(
  query: string,
  fields: {
    readonly label: string;
    readonly hint?: string;
    readonly group?: string;
    readonly section?: string;
    readonly keywords?: readonly string[];
  },
): boolean {
  return [fields.label, fields.hint ?? '', fields.group ?? '', fields.section ?? '', ...(fields.keywords ?? [])]
    .join('\n')
    .toLowerCase()
    .includes(query);
}

/** Whether the current row is hidden by a search in force. */
function useSearchHides(label: string, hint: string | undefined): SettingsSearch | undefined | false {
  const search = useContext(SearchContext);
  const group = useContext(GroupTitleContext);
  if (search === undefined) {
    return undefined;
  }
  const visible = settingMatches(search.query, {
    label,
    ...(hint === undefined ? {} : { hint }),
    ...(group === undefined ? {} : { group }),
    section: search.section,
    ...(search.keywords === undefined ? {} : { keywords: search.keywords }),
  });
  return visible ? search : false;
}

const COMPACT_CONTROL =
  'h-row w-full min-w-0 rounded-md border border-hairline-strong bg-surface-raised px-2 text-sm text-fg-default focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-60';
const CARD_CONTROL =
  'h-7 min-w-0 rounded-md border border-hairline-strong bg-surface-overlay px-2 text-sm text-fg-default focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-60';

/** The border a control whose draft breaks its rule gets, on top of {@link controlClass}. */
const INVALID_CONTROL = ' border-status-danger focus:ring-status-danger';

function controlClass(variant: SettingsVariant, width: 'text' | 'number' | 'select'): string {
  if (variant === 'compact') {
    return COMPACT_CONTROL;
  }
  const widths = { text: 'w-56', number: 'w-24 text-right', select: 'w-auto max-w-64' } as const;
  return `${CARD_CONTROL} ${widths[width]}`;
}

export interface SettingsGroupProps {
  readonly title?: string;
  readonly hint?: string;
  readonly children: React.ReactNode;
}

/** A titled group of rows, with an optional explanatory hint under the heading. */
export function SettingsGroup({ title, hint, children }: SettingsGroupProps) {
  const variant = useContext(VariantContext);
  const search = useContext(SearchContext);
  const rows = <GroupTitleContext.Provider value={title}>{children}</GroupTitleContext.Provider>;

  if (search !== undefined) {
    // Search results are one flat card; the surface draws it.
    return rows;
  }
  if (variant === 'card') {
    return (
      <section className="mt-6 first:mt-0">
        {title !== undefined && <h3 className="mb-2 text-sm font-semibold text-fg-default">{title}</h3>}
        {hint !== undefined && <p className="mb-2 text-xs text-fg-subtle">{hint}</p>}
        <SettingsCard>{rows}</SettingsCard>
      </section>
    );
  }
  return (
    <section className="mb-4">
      {title !== undefined && (
        <h3 className="mb-1 text-xs font-medium tracking-wider text-fg-subtle uppercase">{title}</h3>
      )}
      {hint !== undefined && <p className="mb-2 text-sm text-fg-subtle">{hint}</p>}
      <div className="flex flex-col">{rows}</div>
    </section>
  );
}

/**
 * The rounded card rows sit in. Every card row draws its own top hairline; the inner `-mt-px`
 * tucks the first one under the card's border, so rows can be wrapped in anything (a section's
 * own `<div>`, a fragment) and the separators still only fall *between* rows.
 */
export function SettingsCard({ children, testId }: { readonly children: React.ReactNode; readonly testId?: string }) {
  return (
    <div
      {...(testId === undefined ? {} : { 'data-testid': testId })}
      className="overflow-hidden rounded-lg border border-hairline bg-surface-raised"
    >
      <div className="-mt-px">{children}</div>
    </div>
  );
}

/**
 * Free-form content inside a group that is not a setting — a list of servers, an empty-state
 * line. Padded like a card row; hidden while a search is in force, since it matches nothing.
 */
export function SettingsItem({
  children,
  className = '',
}: {
  readonly children: React.ReactNode;
  readonly className?: string;
}) {
  const variant = useContext(VariantContext);
  const search = useContext(SearchContext);
  if (search !== undefined) {
    return null;
  }
  if (variant === 'card') {
    return <div className={`border-t border-hairline px-4 py-3 ${className}`}>{children}</div>;
  }
  return <div className={`py-1 ${className}`}>{children}</div>;
}

/** What a locked row says. */
export const LOCKED_LABEL = 'Managed';
const LOCKED_TITLE = "Set by your organization's managed-preferences policy; it cannot be changed here.";

interface RowState {
  readonly locked: boolean;
  readonly modified: boolean;
  readonly reset: (() => void) | undefined;
}

/** Resolves a row's lock, modified flag and reset action from its props and the controller. */
function useRowState(setting: string | undefined, lockedProp: boolean): RowState {
  const controller = useContext(ControllerContext);
  if (setting === undefined || controller === undefined) {
    return { locked: lockedProp, modified: false, reset: undefined };
  }
  const locked = lockedProp || controller.locked(setting);
  const modified = controller.isModified(setting);
  return {
    locked,
    modified,
    reset:
      modified && !locked && controller.canReset(setting)
        ? () => {
            controller.reset(setting);
          }
        : undefined,
  };
}

interface RowProps {
  readonly label: string;
  /** The control the `<label>` is bound to; omitted for a control labelled by `aria-labelledby`. */
  readonly htmlFor?: string;
  readonly labelId?: string;
  readonly hint?: string;
  /** Set by a managed-preferences policy: the control is disabled and the row says why. */
  readonly locked?: boolean;
  readonly modified?: boolean;
  readonly onReset?: (() => void) | undefined;
  /** Why the control's draft is refused, shown under the row; the control points at it by `errorId`. */
  readonly error?: string | undefined;
  readonly errorId?: string;
  /** Shown right after the control: where an empty field's value comes from, or a way back to it. */
  readonly aside?: React.ReactNode;
  /** A line under the hint, inside the row: why the control is unavailable here. */
  readonly note?: React.ReactNode;
  readonly children: React.ReactNode;
}

/** The inline message under a row whose draft breaks its rule. */
function RowError({ id, message }: { readonly id: string | undefined; readonly message: string }) {
  return (
    <p id={id} data-testid="setting-error" className="mt-0.5 text-xs text-status-danger">
      {message}
    </p>
  );
}

function LockedPill() {
  return (
    <span
      title={LOCKED_TITLE}
      className="shrink-0 rounded-full border border-status-warning px-1.5 text-2xs leading-4 text-status-warning"
    >
      {LOCKED_LABEL}
    </span>
  );
}

function Row({
  label,
  htmlFor,
  labelId,
  hint,
  locked = false,
  modified = false,
  onReset,
  error,
  errorId,
  aside,
  note,
  children,
}: RowProps) {
  const variant = useContext(VariantContext);
  const search = useSearchHides(label, hint);
  if (search === false) {
    return null;
  }

  if (variant === 'compact') {
    return (
      <div data-setting-row="" className="py-0.5" {...(locked ? { 'data-locked': 'true' } : {})}>
        <div className="flex items-center gap-2">
          <label
            htmlFor={htmlFor}
            id={labelId}
            className="w-44 shrink-0 truncate text-sm text-fg-muted"
            title={hint ?? label}
          >
            {label}
          </label>
          <div className="min-w-0 flex-1">{children}</div>
          {aside}
          {locked && <LockedPill />}
        </div>
        {note !== undefined && <div className="pl-46 text-xs text-fg-subtle">{note}</div>}
        {error !== undefined && (
          <div className="pl-46">
            <RowError id={errorId} message={error} />
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      data-setting-row=""
      {...(locked ? { 'data-locked': 'true' } : {})}
      {...(modified ? { 'data-modified': 'true' } : {})}
      className="group/row flex min-h-14 items-center gap-4 border-t border-hairline px-4 py-2.5"
    >
      <div className="min-w-0 flex-1">
        {search !== undefined && (
          <div data-testid="setting-crumb" className="mb-0.5 text-xs text-fg-subtle">
            {search.crumb}
          </div>
        )}
        <div className="flex min-w-0 items-center gap-1.5">
          <label htmlFor={htmlFor} id={labelId} className="truncate text-sm text-fg-default">
            {label}
          </label>
          {modified && (
            <span
              data-testid="setting-modified"
              role="img"
              aria-label="Changed from default"
              title="Changed from default"
              className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent"
            />
          )}
          {locked && <LockedPill />}
          {onReset !== undefined && (
            <button
              type="button"
              data-testid="setting-reset"
              aria-label={`Reset ${label} to default`}
              onClick={onReset}
              className="invisible shrink-0 rounded-sm px-0.5 text-xs text-fg-subtle group-focus-within/row:visible group-hover/row:visible hover:text-accent focus-visible:visible"
            >
              Reset
            </button>
          )}
        </div>
        {hint !== undefined && <p className="mt-0.5 text-xs text-fg-subtle">{hint}</p>}
        {note !== undefined && <div className="mt-0.5 text-xs text-fg-subtle">{note}</div>}
        {error !== undefined && <RowError id={errorId} message={error} />}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {children}
        {aside}
      </div>
    </div>
  );
}

export interface SettingsRowProps {
  readonly label: string;
  readonly hint?: string;
  readonly locked?: boolean;
  /** The id of the control inside, for the `<label>`; omit when there is no single control. */
  readonly htmlFor?: string;
  readonly children: React.ReactNode;
}

/**
 * A row with a custom control — a keychain field, a pair of Browse…/Clear buttons, a version
 * readout. Same layout, search and lock behaviour as the typed rows.
 */
export function SettingsRow({ label, hint, locked = false, htmlFor, children }: SettingsRowProps) {
  return (
    <Row
      label={label}
      locked={locked}
      {...(htmlFor === undefined ? {} : { htmlFor })}
      {...(hint === undefined ? {} : { hint })}
    >
      {children}
    </Row>
  );
}

export interface TextSettingProps {
  readonly label: string;
  readonly value: string;
  readonly onCommit: (value: string) => void;
  readonly placeholder?: string;
  readonly readOnly?: boolean;
  readonly hint?: string;
  readonly monospace?: boolean;
  readonly testId?: string;
  /** Locked by a managed-preferences policy: read-only, and the row says so. */
  readonly locked?: boolean;
  /** The dotted preference key this row edits, for the modified dot and per-row Reset. */
  readonly setting?: string;
  /** Strip surrounding whitespace before validating and committing. */
  readonly trim?: boolean;
  /**
   * Why a draft is refused, or `undefined` when it is fine. Checked on every keystroke and again
   * on commit; a refused draft shows the message under the row and is not committed.
   */
  readonly validate?: (value: string) => string | undefined;
}

/**
 * A free-text row. Commits on blur or Enter; Escape restores the last committed value. With
 * `validate`, a draft that breaks the rule is shown as invalid and kept, never committed.
 */
export function TextSetting({
  label,
  value,
  onCommit,
  placeholder,
  readOnly: readOnlyProp = false,
  hint,
  monospace = false,
  testId,
  locked: lockedProp = false,
  setting,
  trim = false,
  validate,
}: TextSettingProps) {
  const id = useId();
  const errorId = useId();
  const variant = useContext(VariantContext);
  const row = useRowState(setting, lockedProp);
  const readOnly = readOnlyProp || row.locked;
  const [draft, setDraft] = useState(value);
  useEffect(() => {
    setDraft(value);
  }, [value]);

  const prepared = trim ? draft.trim() : draft;
  // A read-only field is not being edited, so there is nothing of the user's to refuse.
  const error = readOnly || validate === undefined ? undefined : validate(prepared);

  const commit = (force: boolean): void => {
    if (readOnly || error !== undefined) {
      return;
    }
    if (prepared !== draft) {
      setDraft(prepared);
    }
    if (force || prepared !== value) {
      onCommit(prepared);
    }
  };

  return (
    <Row
      label={label}
      htmlFor={id}
      locked={row.locked}
      modified={row.modified}
      onReset={row.reset}
      error={error}
      errorId={errorId}
      {...(hint !== undefined ? { hint } : {})}
    >
      <input
        id={id}
        aria-label={label}
        {...(testId !== undefined ? { 'data-testid': testId } : {})}
        {...(error !== undefined ? { 'aria-invalid': true, 'aria-describedby': errorId } : {})}
        readOnly={readOnly}
        className={`${controlClass(variant, 'text')}${monospace ? ' font-mono' : ''}${readOnly ? ' text-fg-muted' : ''}${error !== undefined ? INVALID_CONTROL : ''}`}
        value={draft}
        placeholder={placeholder ?? ''}
        onChange={(event) => {
          setDraft(event.target.value);
        }}
        onBlur={() => {
          commit(false);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            commit(true);
          }
          if (event.key === 'Escape' && draft !== value) {
            // Reverting a half-typed value is this key's whole job here; it must not also
            // close the surface the row sits on.
            event.preventDefault();
            setDraft(value);
          }
        }}
      />
    </Row>
  );
}

/** The rule a numeric field enforces; see {@link numberRule}. */
export interface NumberRule {
  readonly min?: number | undefined;
  readonly max?: number | undefined;
  readonly integer: boolean;
}

/** "Enter a whole number from 1 to 65535" — the rule, as the inline message says it. */
export function numberRule({ min, max, integer }: NumberRule): string {
  const kind = integer ? 'a whole number' : 'a number';
  if (min !== undefined && max !== undefined) {
    return `Enter ${kind} from ${min} to ${max}`;
  }
  if (min !== undefined) {
    return `Enter ${kind} of ${min} or more`;
  }
  if (max !== undefined) {
    return `Enter ${kind} of ${max} or less`;
  }
  return `Enter ${kind}`;
}

/**
 * The characters a numeric draft may consist of: digits, a `.` only for a decimal field and a
 * leading `-` only when the rule allows a negative value. Checked against the *whole* draft, so a
 * paste that brings any other character is refused outright rather than partly kept.
 */
function draftPattern({ min, integer }: NumberRule): RegExp {
  const sign = min !== undefined && min < 0 ? '-?' : '';
  return new RegExp(integer ? `^${sign}\\d*$` : `^${sign}\\d*\\.?\\d*$`);
}

/**
 * Parses a (non-empty, pattern-conforming) numeric draft against its rule: the number, or the
 * message to show. `Number()` alone is not enough — it would take `1e3`, `0x10` or ` 80.5`.
 */
export function parseNumberDraft(draft: string, rule: NumberRule): number | { readonly error: string } {
  const parsed = draftPattern(rule).test(draft) ? Number(draft) : Number.NaN;
  const ok =
    /\d/.test(draft) &&
    Number.isFinite(parsed) &&
    (!rule.integer || Number.isSafeInteger(parsed)) &&
    (rule.min === undefined || parsed >= rule.min) &&
    (rule.max === undefined || parsed <= rule.max);
  return ok ? parsed : { error: numberRule(rule) };
}

export interface NumberSettingProps {
  readonly label: string;
  readonly value: number | undefined;
  /** `undefined` means "cleared" — the field was emptied, so the setting falls back to its default. */
  readonly onCommit: (value: number | undefined) => void;
  /** Shown while the field is empty; say what empty means — usually the default value. */
  readonly placeholder?: string;
  readonly min?: number;
  /** The largest value accepted. */
  readonly max?: number;
  /** Whole numbers only (the default — nearly every setting is one). `false` also accepts a `.`. */
  readonly integer?: boolean;
  /** A short unit shown right after the field ("ms", "MiB", "days"), so the label need not carry it. */
  readonly unit?: string;
  readonly hint?: string;
  readonly testId?: string;
  /** Not editable right now (the setting does not apply in the current mode); the value still shows. */
  readonly readOnly?: boolean;
  /** Off, like {@link readOnly}, but greyed out too: the feature the setting tunes is off or unavailable. */
  readonly disabled?: boolean;
  /** Locked by a managed-preferences policy: disabled, and the row says so. */
  readonly locked?: boolean;
  /** The dotted preference key this row edits, for the modified dot and per-row Reset. */
  readonly setting?: string;
  /** Shown right after the field, such as where an empty field's value comes from. */
  readonly aside?: React.ReactNode;
}

/**
 * A numeric row. Only digits can be typed (plus `.` for a decimal field and `-` when the minimum is
 * negative); a pasted value with anything else is refused whole. A draft outside the rule says so
 * under the row and is not committed. An empty field commits `undefined` (inherit / no value).
 */
export function NumberSetting({
  label,
  value,
  onCommit,
  placeholder,
  min,
  max,
  integer = true,
  unit,
  hint,
  testId,
  readOnly: readOnlyProp = false,
  disabled = false,
  locked: lockedProp = false,
  setting,
  aside,
}: NumberSettingProps) {
  const id = useId();
  const errorId = useId();
  const unitId = useId();
  const variant = useContext(VariantContext);
  const row = useRowState(setting, lockedProp);
  const readOnly = readOnlyProp || disabled;
  const rule: NumberRule = { min, max, integer };
  const asText = value === undefined ? '' : String(value);
  const [draft, setDraft] = useState(asText);
  useEffect(() => {
    setDraft(asText);
  }, [asText]);

  const parsed = draft.length === 0 ? undefined : parseNumberDraft(draft, rule);
  const error = !readOnly && typeof parsed === 'object' ? parsed.error : undefined;

  const commit = (): void => {
    if (readOnly || typeof parsed === 'object') {
      // An invalid draft stays, with its message, for the user to fix or Escape away.
      return;
    }
    if (parsed === undefined) {
      if (value !== undefined) {
        onCommit(undefined);
      }
      return;
    }
    if (parsed !== value) {
      onCommit(parsed);
    }
  };

  const describedBy = [...(error !== undefined ? [errorId] : []), ...(unit !== undefined ? [unitId] : [])];

  const input = (
    <input
      id={id}
      aria-label={label}
      {...(testId !== undefined ? { 'data-testid': testId } : {})}
      {...(error !== undefined ? { 'aria-invalid': true } : {})}
      {...(describedBy.length > 0 ? { 'aria-describedby': describedBy.join(' ') } : {})}
      disabled={row.locked || disabled}
      readOnly={readOnly}
      inputMode={integer ? 'numeric' : 'decimal'}
      className={`${controlClass(variant, 'number')}${readOnly ? ' text-fg-muted' : ''}${error !== undefined ? INVALID_CONTROL : ''}`}
      value={draft}
      placeholder={placeholder ?? ''}
      onChange={(event) => {
        // Surrounding whitespace (a copied value's trailing space) is dropped; anything else that
        // is not part of a number leaves the draft as it was, so letters cannot be typed at all.
        const next = event.target.value.trim();
        if (draftPattern(rule).test(next)) {
          setDraft(next);
        }
      }}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          commit();
        }
        if (event.key === 'Escape' && draft !== asText) {
          event.preventDefault();
          setDraft(asText);
        }
      }}
    />
  );

  return (
    <Row
      label={label}
      htmlFor={id}
      locked={row.locked}
      modified={row.modified}
      onReset={row.reset}
      error={error}
      errorId={errorId}
      aside={aside}
      {...(hint !== undefined ? { hint } : {})}
    >
      {unit === undefined ? (
        input
      ) : (
        <span className="flex min-w-0 items-center gap-1.5">
          {input}
          <span id={unitId} data-testid="setting-unit" className="shrink-0 text-xs text-fg-subtle">
            {unit}
          </span>
        </span>
      )}
    </Row>
  );
}

export interface BooleanSettingProps {
  readonly label: string;
  readonly value: boolean;
  readonly onChange: (value: boolean) => void;
  readonly hint?: string;
  readonly disabled?: boolean;
  readonly testId?: string;
  /** Locked by a managed-preferences policy: disabled, and the row says so. */
  readonly locked?: boolean;
  /** The dotted preference key this row edits, for the modified dot and per-row Reset. */
  readonly setting?: string;
  /** Shown right after the control, such as where an unset value comes from. */
  readonly aside?: React.ReactNode;
  /** A line under the hint, inside the row: why the switch is unavailable here. */
  readonly note?: React.ReactNode;
}

/**
 * An on/off row: a switch in the card variant, a checkbox in the compact one. Commits
 * immediately — there is no half-typed state to protect.
 */
export function BooleanSetting({
  label,
  value,
  onChange,
  hint,
  disabled = false,
  testId,
  locked: lockedProp = false,
  setting,
  aside,
  note,
}: BooleanSettingProps) {
  const id = useId();
  const variant = useContext(VariantContext);
  const row = useRowState(setting, lockedProp);
  const inert = disabled || row.locked;
  return (
    <Row
      label={label}
      htmlFor={id}
      locked={row.locked}
      modified={row.modified}
      onReset={row.reset}
      aside={aside}
      note={note}
      {...(hint !== undefined ? { hint } : {})}
    >
      {variant === 'card' ? (
        <button
          id={id}
          type="button"
          role="switch"
          aria-checked={value}
          aria-label={label}
          {...(testId !== undefined ? { 'data-testid': testId } : {})}
          disabled={inert}
          onClick={() => {
            onChange(!value);
          }}
          className={`relative h-5 w-[34px] shrink-0 rounded-full transition-colors focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-surface-raised focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-45 ${
            value ? 'bg-accent' : 'bg-hairline-strong'
          }`}
        >
          <span
            aria-hidden="true"
            className={`absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-fg-default shadow-sm transition-transform ${
              value ? 'translate-x-3.5' : 'translate-x-0'
            }`}
          />
        </button>
      ) : (
        <input
          id={id}
          type="checkbox"
          aria-label={label}
          {...(testId !== undefined ? { 'data-testid': testId } : {})}
          disabled={inert}
          checked={value}
          onChange={(event) => {
            onChange(event.target.checked);
          }}
          className="h-4 w-4 accent-[var(--color-accent)]"
        />
      )}
    </Row>
  );
}

export interface EnumSettingOption {
  readonly value: string;
  readonly label: string;
}

export interface EnumSettingProps {
  readonly label: string;
  readonly value: string;
  readonly options: readonly EnumSettingOption[];
  readonly onChange: (value: string) => void;
  readonly hint?: string;
  readonly testId?: string;
  /** Locked by a managed-preferences policy: disabled, and the row says so. */
  readonly locked?: boolean;
  /** The dotted preference key this row edits, for the modified dot and per-row Reset. */
  readonly setting?: string;
  /**
   * `auto` (the default) shows two or three options as a segmented control in the card variant
   * and anything else as a `<select>`; `select` always uses the `<select>` — for a list whose
   * length depends on the user's data.
   */
  readonly display?: 'auto' | 'select';
}

/** The longest closed set shown as a segmented control rather than a `<select>`. */
const SEGMENTED_MAX = 3;

/** A row for a closed set of values: a segmented control when short, a `<select>` otherwise. */
export function EnumSetting({
  label,
  value,
  options,
  onChange,
  hint,
  testId,
  locked: lockedProp = false,
  setting,
  display = 'auto',
}: EnumSettingProps) {
  const id = useId();
  const labelId = useId();
  const variant = useContext(VariantContext);
  const row = useRowState(setting, lockedProp);
  const segmented = variant === 'card' && display === 'auto' && options.length >= 2 && options.length <= SEGMENTED_MAX;

  if (segmented) {
    const select = (index: number): void => {
      const option = options[(index + options.length) % options.length];
      if (option !== undefined && option.value !== value) {
        onChange(option.value);
      }
      // Roving focus follows the selection, as in any radio group.
      const group = document.getElementById(id);
      group?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[(index + options.length) % options.length]?.focus();
    };
    const current = options.findIndex((option) => option.value === value);
    return (
      <Row
        label={label}
        labelId={labelId}
        locked={row.locked}
        modified={row.modified}
        onReset={row.reset}
        {...(hint !== undefined ? { hint } : {})}
      >
        <div
          id={id}
          role="radiogroup"
          aria-labelledby={labelId}
          {...(row.locked ? { 'aria-disabled': true } : {})}
          {...(testId !== undefined ? { 'data-testid': testId } : {})}
          data-value={value}
          className="flex overflow-hidden rounded-md border border-hairline-strong"
        >
          {options.map((option, index) => {
            const checked = option.value === value;
            return (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={checked}
                tabIndex={checked || (current === -1 && index === 0) ? 0 : -1}
                disabled={row.locked}
                {...(testId !== undefined ? { 'data-testid': `${testId}-${option.value}` } : {})}
                onClick={() => {
                  if (!checked) {
                    onChange(option.value);
                  }
                }}
                onKeyDown={(event) => {
                  if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
                    event.preventDefault();
                    select(index + 1);
                  } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
                    event.preventDefault();
                    select(index - 1);
                  }
                }}
                className={`h-7 border-l border-hairline-strong px-2.5 text-sm whitespace-nowrap first:border-l-0 focus-visible:relative focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60 ${
                  checked
                    ? 'bg-surface-active text-fg-default'
                    : 'bg-surface-overlay text-fg-muted hover:text-fg-default'
                }`}
              >
                {option.label}
              </button>
            );
          })}
        </div>
      </Row>
    );
  }

  return (
    <Row
      label={label}
      htmlFor={id}
      locked={row.locked}
      modified={row.modified}
      onReset={row.reset}
      {...(hint !== undefined ? { hint } : {})}
    >
      <select
        id={id}
        aria-label={label}
        {...(testId !== undefined ? { 'data-testid': testId } : {})}
        disabled={row.locked}
        className={controlClass(variant, 'select')}
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </Row>
  );
}

export interface ReadOnlySettingProps {
  readonly label: string;
  readonly value: string;
  readonly hint?: string;
  readonly testId?: string;
}

/** A row that only reports a value — an interface's WS-A version, a command's shortcut. */
export function ReadOnlySetting({ label, value, hint, testId }: ReadOnlySettingProps) {
  const id = useId();
  const variant = useContext(VariantContext);
  return (
    <Row label={label} htmlFor={id} {...(hint !== undefined ? { hint } : {})}>
      <output
        id={id}
        data-testid={testId}
        className={`block truncate py-1 text-sm text-fg-muted${variant === 'card' ? ' max-w-64 text-right' : ''}`}
      >
        {value}
      </output>
    </Row>
  );
}
