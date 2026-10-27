/**
 * Variables in the plain fields of a request (#340): the URL bar, the key/value tables and the auth
 * inputs. Monaco editors have their own wiring (`editor/variable-assist-monaco.ts`); both follow the
 * same rules (`editor/variable-assist.ts`).
 *
 * A request editor puts a {@link VariableAssistContext} around its tabs. A field inside one gets:
 *
 * - **completion** — a listbox under the field while the caret is in an open `${…`, driven from the
 *   keyboard (↑/↓, Enter or Tab to accept, Escape to close);
 * - **marks** — {@link VariableText} draws the field's text with each reference coloured, and one
 *   that resolves to nothing underlined in red, where it is written;
 * - **hover** — a card over a reference: its value (masked for a secret), its scope, a link to edit it;
 * - **Set as Variable…** — right-click a selection.
 *
 * Outside a request (the Environments tables, a dialog) there is no context, and a field is exactly
 * what it was.
 */
import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { propertyReferences } from '@wirebench/engine/rest';
import type { VariableEditTargetWire } from '@shared/wire-base.js';
import {
  classifyReference,
  completionContext,
  completionItems,
  hoverContent,
  type HoverContent,
  type RequestVariables,
  type VariableCompletionItem,
} from '../editor/variable-assist.js';

/** What a request editor lends the fields inside it. */
export interface VariableAssist {
  /** The request's variables; `undefined` while they are fetched (nothing is marked meanwhile). */
  readonly variables: RequestVariables | undefined;
  /** Opens **Set as Variable…**; `replace` writes the reference over the selection. */
  readonly setAsVariable: (selected: string, replace: ((reference: string) => void) | undefined) => void;
  /** Opens the tab that edits a variable's scope. */
  readonly openEdit: (target: VariableEditTargetWire) => void;
}

export const VariableAssistContext = createContext<VariableAssist | undefined>(undefined);

/** The surrounding request editor's variable help, or `undefined` outside one. */
export function useVariableAssist(): VariableAssist | undefined {
  return useContext(VariableAssistContext);
}

const RESOLVED_CLASS = 'text-accent';
const UNRESOLVED_CLASS = 'text-accent underline decoration-status-danger decoration-wavy underline-offset-2';

/**
 * The class and data attributes of the span drawing one reference, `raw`, found at `start` in a
 * field's text: coloured, underlined when it resolves to nothing, and findable by the hover.
 */
export function referenceMark(
  raw: string,
  start: number,
  variables: RequestVariables | undefined,
): { readonly className: string; readonly props: Readonly<Record<string, string | number>> } {
  const [reference] = propertyReferences(raw);
  const unresolved = reference !== undefined && classifyReference(reference, variables).status === 'unresolved';
  return {
    className: unresolved ? UNRESOLVED_CLASS : RESOLVED_CLASS,
    props: {
      'data-variable-start': start,
      'data-variable-end': start + raw.length,
      ...(unresolved ? { 'data-unresolved': 'true' } : {}),
    },
  };
}

/**
 * `text` with its references coloured and the unresolved ones underlined: what a field's mirror (the
 * copy drawn behind or over its own text) shows. Each reference's span carries its offsets, which is
 * how a hover finds the one under the pointer.
 */
export function VariableText({ text, plainClassName }: { readonly text: string; readonly plainClassName?: string }) {
  const variables = useVariableAssist()?.variables;
  const parts: ReactNode[] = [];
  let at = 0;
  for (const reference of propertyReferences(text)) {
    if (reference.start > at) {
      parts.push(
        <span key={`t${String(at)}`} className={plainClassName}>
          {text.slice(at, reference.start)}
        </span>,
      );
    }
    const raw = text.slice(reference.start, reference.end);
    const mark = referenceMark(raw, reference.start, variables);
    parts.push(
      <span key={`r${String(reference.start)}`} data-kind="property" className={mark.className} {...mark.props}>
        {raw}
      </span>,
    );
    at = reference.end;
  }
  if (at < text.length) {
    parts.push(
      <span key={`t${String(at)}`} className={plainClassName}>
        {text.slice(at)}
      </span>,
    );
  }
  return <>{parts}</>;
}

type Field = HTMLInputElement | HTMLTextAreaElement;

/** The open completion: where it replaces, what it offers, which item is active. */
interface Completion {
  readonly start: number;
  readonly caret: number;
  readonly items: readonly VariableCompletionItem[];
  readonly active: number;
}

/** The hover card's content and where it sits. */
interface Hovered {
  readonly content: HoverContent;
  readonly left: number;
  readonly top: number;
}

/** The selection menu's position and what it acts on. */
interface SelectionMenu {
  readonly left: number;
  readonly top: number;
  readonly start: number;
  readonly end: number;
}

let nextListId = 1;

/** The line box of `element` the point lies in, if any. */
function boxAt(element: Element, x: number, y: number): DOMRect | undefined {
  for (const rect of Array.from(element.getClientRects())) {
    if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) return rect;
  }
  return undefined;
}

export interface VariableFieldProps {
  readonly value: string;
  /** Sets the field's text when a completion is accepted; the caller decides when it commits. */
  readonly onValueChange: (next: string) => void;
  /**
   * Writes the field's text once Set as Variable has put a reference over the selection. By then the
   * field has lost focus (the dialog took it), so a field that commits on blur must commit this
   * itself. Defaults to {@link onValueChange}.
   */
  readonly onReplace?: ((next: string) => void) | undefined;
}

/** The handlers {@link VariableFieldBindings.fieldProps} composes with the assist's. */
export interface OwnFieldHandlers<E extends Field> {
  readonly onKeyDown?: ((event: React.KeyboardEvent<E>) => void) | undefined;
  readonly onBlur?: ((event: React.FocusEvent<E>) => void) | undefined;
}

/** The props the assist puts on a field. */
export interface AssistedFieldProps<E extends Field> {
  readonly ref: (element: E | null) => void;
  readonly onKeyDown: (event: React.KeyboardEvent<E>) => void;
  readonly onKeyUp: (event: React.KeyboardEvent<E>) => void;
  readonly onClick: (event: React.MouseEvent<E>) => void;
  readonly onInput: (event: React.FormEvent<E>) => void;
  readonly onBlur: (event: React.FocusEvent<E>) => void;
  readonly onContextMenu: (event: React.MouseEvent<E>) => void;
  readonly 'aria-autocomplete'?: 'list';
  readonly 'aria-controls'?: string;
  readonly 'aria-activedescendant'?: string;
}

/** What {@link useVariableField} hands the host: props for the wrapper and the field, and what to render. */
export interface VariableFieldBindings {
  /** Spread on the field's `relative` wrapper: hover is tracked there, over the mirror. */
  readonly wrapperProps: {
    readonly ref: React.RefObject<HTMLDivElement | null>;
    readonly onMouseMove?: (event: React.MouseEvent) => void;
    readonly onMouseLeave?: () => void;
  };
  /** Composes the field's own handlers with the assist's, which run first. */
  readonly fieldProps: <E extends Field>(own?: OwnFieldHandlers<E>) => AssistedFieldProps<E>;
  /** The popups (completion list, hover card, selection menu), portalled; render it anywhere. */
  readonly popups: ReactNode;
  /** Whether the field is inside a request editor at all. */
  readonly active: boolean;
  /** The request's variables, for a host that draws its own mirror. */
  readonly variables: RequestVariables | undefined;
}

/** Keys the open completion list handles itself. */
const LIST_KEYS = new Set(['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape']);

/**
 * The plain-field side of variables in the editor. Without a {@link VariableAssistContext} every
 * binding passes the field's own handlers straight through.
 */
export function useVariableField({ value, onValueChange, onReplace }: VariableFieldProps): VariableFieldBindings {
  const assist = useVariableAssist();
  const wrapper = useRef<HTMLDivElement>(null);
  const field = useRef<Field | null>(null);
  const [completion, setCompletion] = useState<Completion>();
  const [hovered, setHovered] = useState<Hovered>();
  const [menu, setMenu] = useState<SelectionMenu>();
  const hideTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const listId = useMemo(() => `variable-completion-${String(nextListId++)}`, []);

  useEffect(
    () => () => {
      clearTimeout(hideTimer.current);
    },
    [],
  );

  const variables = assist?.variables;

  /** Re-reads the caret and opens, updates or closes the completion. */
  const track = (element: Field): void => {
    if (variables === undefined) return;
    const caret = element.selectionStart ?? element.value.length;
    const context = caret === element.selectionEnd ? completionContext(element.value.slice(0, caret)) : undefined;
    const items = context === undefined ? [] : completionItems(context, variables, element.value.charAt(caret) === '}');
    if (context === undefined || items.length === 0) {
      setCompletion(undefined);
      return;
    }
    setCompletion((previous) => ({
      start: context.start,
      caret,
      items,
      active: previous?.start === context.start ? Math.min(previous.active, items.length - 1) : 0,
    }));
  };

  const accept = (item: VariableCompletionItem): void => {
    const element = field.current;
    if (completion === undefined) return;
    const next = value.slice(0, completion.start) + item.insertText + value.slice(completion.caret);
    const caret = completion.start + item.insertText.length;
    setCompletion(undefined);
    onValueChange(next);
    // After React has written the new value: the caret goes after what was inserted.
    requestAnimationFrame(() => {
      element?.setSelectionRange(caret, caret);
    });
  };

  const scheduleHide = (): void => {
    clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => {
      setHovered(undefined);
    }, 200);
  };

  const showHover = (event: React.MouseEvent): void => {
    if (variables === undefined || wrapper.current === null) return;
    for (const span of Array.from(wrapper.current.querySelectorAll('[data-variable-start]'))) {
      const rect = boxAt(span, event.clientX, event.clientY);
      if (rect === undefined) continue;
      const start = Number(span.getAttribute('data-variable-start'));
      const reference = propertyReferences(value).find((candidate) => candidate.start === start);
      const content =
        reference === undefined
          ? undefined
          : hoverContent(classifyReference(reference, variables), value.slice(reference.start, reference.end));
      clearTimeout(hideTimer.current);
      setHovered(content === undefined ? undefined : { content, left: rect.left, top: rect.bottom + 4 });
      return;
    }
    scheduleHide();
  };

  const fieldRect = completion === undefined ? undefined : field.current?.getBoundingClientRect();
  const popups =
    assist === undefined
      ? null
      : createPortal(
          <>
            {completion !== undefined && (
              <ul
                id={listId}
                role="listbox"
                aria-label="Variables"
                data-testid="variable-completion"
                className="fixed z-dialog max-h-64 min-w-56 overflow-auto rounded-md border border-hairline bg-surface-raised p-1 text-sm shadow-lg"
                style={{ left: fieldRect?.left ?? 0, top: (fieldRect?.bottom ?? 0) + 2 }}
              >
                {completion.items.map((item, index) => (
                  <li
                    key={`${item.label}-${item.detail}`}
                    id={`${listId}-${String(index)}`}
                    role="option"
                    aria-selected={index === completion.active}
                    className={`flex cursor-pointer items-baseline gap-4 rounded px-2 py-1 ${index === completion.active ? 'bg-accent-muted' : ''}`}
                    // Keep focus in the field: a click here must not blur it first.
                    onMouseDown={(event) => {
                      event.preventDefault();
                      accept(item);
                    }}
                  >
                    <span className="font-mono text-fg-default">{item.label}</span>
                    <span className="max-w-48 truncate font-mono text-xs text-fg-subtle">{item.documentation}</span>
                    <span className="ml-auto shrink-0 text-xs text-fg-subtle">{item.detail}</span>
                  </li>
                ))}
              </ul>
            )}
            {hovered !== undefined && (
              <div
                role="tooltip"
                data-testid="variable-hover"
                className="fixed z-dialog flex max-w-96 flex-col gap-1 rounded-md border border-hairline bg-surface-overlay px-3 py-2 text-sm shadow-lg"
                style={{ left: hovered.left, top: hovered.top }}
                onMouseEnter={() => {
                  clearTimeout(hideTimer.current);
                }}
                onMouseLeave={scheduleHide}
              >
                <span>
                  <span className="font-mono font-medium text-fg-default">{hovered.content.title}</span>
                  <span className={hovered.content.unresolved === true ? 'text-status-danger' : 'text-fg-subtle'}>
                    {` — ${hovered.content.scope}`}
                  </span>
                </span>
                <span className="font-mono break-all whitespace-pre-wrap text-fg-muted">{hovered.content.value}</span>
                {hovered.content.edit !== undefined && (
                  <button
                    type="button"
                    className="self-start text-accent hover:underline"
                    onClick={() => {
                      const target = hovered.content.edit;
                      setHovered(undefined);
                      if (target !== undefined) assist.openEdit(target);
                    }}
                  >
                    {`Edit in ${hovered.content.scope}`}
                  </button>
                )}
              </div>
            )}
            {menu !== undefined && (
              <div
                role="menu"
                aria-label="Selection"
                className="fixed z-dialog min-w-44 rounded-md border border-hairline bg-surface-raised p-1 shadow-lg"
                style={{ left: menu.left, top: menu.top }}
              >
                <button
                  type="button"
                  role="menuitem"
                  autoFocus
                  className="flex w-full cursor-pointer items-center rounded px-2 py-1.5 text-left text-sm text-fg-default hover:bg-accent-muted focus:bg-accent-muted focus:outline-none"
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') {
                      setMenu(undefined);
                      field.current?.focus();
                    }
                  }}
                  onBlur={() => {
                    setMenu(undefined);
                  }}
                  onClick={() => {
                    const { start, end } = menu;
                    setMenu(undefined);
                    assist.setAsVariable(value.slice(start, end), (reference) => {
                      (onReplace ?? onValueChange)(value.slice(0, start) + reference + value.slice(end));
                    });
                  }}
                >
                  Set as Variable…
                </button>
              </div>
            )}
          </>,
          document.body,
        );

  const fieldProps = <E extends Field>(own: OwnFieldHandlers<E> = {}): AssistedFieldProps<E> => {
    const open = completion !== undefined;
    return {
      ref: (element) => {
        field.current = element;
      },
      onKeyDown: (event) => {
        if (completion !== undefined && LIST_KEYS.has(event.key)) {
          event.preventDefault();
          if (event.key === 'Escape') {
            // Closes the list only: the cell's own Escape (revert the edit) waits for the next press.
            event.stopPropagation();
            setCompletion(undefined);
          } else if (event.key === 'Enter' || event.key === 'Tab') {
            const item = completion.items[completion.active];
            if (item !== undefined) accept(item);
          } else {
            const count = completion.items.length;
            const step = event.key === 'ArrowDown' ? 1 : count - 1;
            setCompletion({ ...completion, active: (completion.active + step) % count });
          }
          return;
        }
        own.onKeyDown?.(event);
      },
      onKeyUp: (event) => {
        if (!LIST_KEYS.has(event.key)) track(event.currentTarget);
      },
      onClick: (event) => {
        track(event.currentTarget);
      },
      onInput: (event) => {
        track(event.currentTarget);
      },
      onBlur: (event) => {
        setCompletion(undefined);
        own.onBlur?.(event);
      },
      onContextMenu: (event) => {
        if (assist === undefined) return;
        const { selectionStart, selectionEnd } = event.currentTarget;
        if (selectionStart === null || selectionEnd === null || selectionStart === selectionEnd) return;
        event.preventDefault();
        setMenu({ left: event.clientX, top: event.clientY, start: selectionStart, end: selectionEnd });
      },
      // The field keeps its textbox role (an autocompleting one): its list is announced through
      // `aria-controls` and the active option through `aria-activedescendant` while it is open.
      ...(assist === undefined
        ? {}
        : {
            'aria-autocomplete': 'list' as const,
            ...(open
              ? { 'aria-controls': listId, 'aria-activedescendant': `${listId}-${String(completion.active)}` }
              : {}),
          }),
    };
  };

  return {
    wrapperProps:
      assist === undefined ? { ref: wrapper } : { ref: wrapper, onMouseMove: showHover, onMouseLeave: scheduleHide },
    fieldProps,
    popups,
    active: assist !== undefined,
    variables,
  };
}

export interface VariableInputProps extends Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  'value' | 'onChange' | 'onFocus' | 'onBlur'
> {
  readonly value: string;
  readonly onValueChange: (next: string) => void;
  /** The input's own classes; the mirror copies its padding and font. */
  readonly className: string;
}

/**
 * A plain one-line input with the variable help of {@link useVariableField}: completion while typing,
 * and — at rest, when it holds a reference — its text drawn by {@link VariableText}, so an unresolved
 * name is underlined where it is written and a reference can be hovered. Outside a request editor it
 * is just the input.
 */
export function VariableInput({ value, onValueChange, className, ...rest }: VariableInputProps) {
  const assist = useVariableField({ value, onValueChange });
  const [focused, setFocused] = useState(false);
  const mirrored = assist.active && !focused && value.includes('${');
  return (
    <div className="relative min-w-0 flex-1" {...assist.wrapperProps}>
      <input
        {...rest}
        className={className}
        value={value}
        // Inline, so it wins over the class's text colour: at rest only the mirror's copy shows.
        style={mirrored ? { color: 'transparent' } : undefined}
        onChange={(event) => {
          onValueChange(event.target.value);
        }}
        onFocus={() => {
          setFocused(true);
        }}
        {...assist.fieldProps<HTMLInputElement>({
          onBlur: () => {
            setFocused(false);
          },
        })}
      />
      {mirrored && (
        <div
          aria-hidden="true"
          className={`${className} pointer-events-none absolute inset-0 flex items-center overflow-hidden border-transparent bg-transparent whitespace-pre`}
        >
          <VariableText text={value} />
        </div>
      )}
      {assist.popups}
    </div>
  );
}
