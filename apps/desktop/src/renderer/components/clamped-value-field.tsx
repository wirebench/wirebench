/**
 * A one-value field for a table cell that keeps long text readable without taking over the table.
 *
 * At rest it shows at most two lines, ending in an ellipsis, and a short value sits on one line
 * like a plain input. Focus (a click, or Tab into it) grows it to show the whole value, wrapped, so
 * it can be read and edited without scrolling sideways — up to eight lines, scrolling past that —
 * and leaving it folds it back to two lines.
 *
 * It is a `<textarea>` throughout, so its label, its value and anything that fills it in see one
 * element whether it is folded or not. Folded, the textarea's own text is transparent and a
 * clamped copy is drawn over it (CSS `line-clamp` does not apply to a textarea). Enter commits
 * rather than adding a line break — a header value has none — and the caller's handlers decide
 * what commit and Escape mean.
 */
import { useLayoutEffect, useRef, useState } from 'react';

/** One line of text, and the vertical padding plus border around it: 26px, the `h-row` height. */
const LINE = 18;
const CHROME = 8;
/** Focused, the field grows to this many lines and scrolls past them, so it never swallows the pane. */
const OPEN_LINES = 8;

export interface ClampedValueFieldProps {
  readonly value: string;
  readonly onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => void;
  readonly onBlur?: () => void;
  readonly onKeyDown?: (event: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  readonly 'aria-label': string;
  readonly 'data-testid'?: string;
  readonly readOnly?: boolean;
  /** The look of the box — border, background, text size — as the table's other inputs have it. */
  readonly className: string;
}

export function ClampedValueField({ value, onChange, onBlur, onKeyDown, className, ...rest }: ClampedValueFieldProps) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [focused, setFocused] = useState(false);
  // The table's input class fixes one row's height; here the height is the text's, set below.
  const box = className.replace(/(^|\s)h-row(?=\s|$)/g, ' ');

  // Height follows the text: all of it while focused, at most two lines otherwise. Measured from
  // `scrollHeight`, which is 0 where nothing is laid out (tests), so the CSS height stands there.
  useLayoutEffect(() => {
    const area = ref.current;
    if (area === null) return;
    area.style.height = 'auto';
    const full = area.scrollHeight;
    if (full === 0) {
      area.style.height = '';
      return;
    }
    const height = Math.min(full, LINE * (focused ? OPEN_LINES : 2) + CHROME);
    area.style.height = `${String(height + 2)}px`;
    area.style.overflowY = focused && full > height ? 'auto' : 'hidden';
  }, [value, focused]);

  return (
    <div className="relative min-w-0">
      <textarea
        ref={ref}
        rows={1}
        spellCheck={false}
        value={value}
        className={`${box} block resize-none overflow-hidden py-[3px] leading-[18px] break-all whitespace-pre-wrap`}
        // Inline, so it wins over the text colour the caller's class sets: folded, only the clamped
        // copy below is visible.
        style={focused ? undefined : { color: 'transparent' }}
        // Folded, the whole value is one hover away.
        {...(focused || value === '' ? {} : { title: value })}
        onChange={onChange}
        onFocus={() => {
          setFocused(true);
        }}
        onBlur={() => {
          setFocused(false);
          onBlur?.();
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
            // Enter saves, as it does in every other cell; a header value never holds a line break.
            event.preventDefault();
          }
          onKeyDown?.(event);
        }}
        {...rest}
      />
      {!focused && (
        <div
          aria-hidden="true"
          className={`${box} pointer-events-none absolute inset-x-0 top-0 line-clamp-2 border-transparent bg-transparent py-[3px] leading-[18px] break-all whitespace-pre-wrap`}
        >
          {value}
        </div>
      )}
    </div>
  );
}
