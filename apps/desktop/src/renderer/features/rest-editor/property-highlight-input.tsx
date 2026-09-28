/**
 * A single-line text field with a highlighted mirror behind it: property references (`${…}`) and
 * path placeholders (`{param}`) are coloured so an unfilled one is visible while typing.
 *
 * Shared by the URL bar (`url-bar.tsx`) and the Webhooks settings dialog's Target field
 * (`webhook-items/webhook-settings-dialog.tsx`) — both are a URL-shaped value that may hold a
 * property reference, and neither needs a Monaco instance: a single-line field has no folding, no
 * find, no completion, and one Monaco per field would be paid for on every mount.
 */
import { useRef } from 'react';
import { urlSegments } from '../../state/rest-url.js';

const FIELD_FONT = 'font-mono text-sm leading-[26px]';

export interface PropertyHighlightInputProps {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly ariaLabel: string;
  /** The input's own `data-testid`; the mirror behind it gets `${testId}-highlight`. */
  readonly testId: string;
  readonly id?: string | undefined;
  readonly placeholder?: string | undefined;
  readonly onKeyDown?: ((event: React.KeyboardEvent<HTMLInputElement>) => void) | undefined;
}

/** The field and its mirror, sized to fill whatever flex/grid cell it is put in. */
export function PropertyHighlightInput({
  value,
  onChange,
  ariaLabel,
  testId,
  id,
  placeholder,
  onKeyDown,
}: PropertyHighlightInputProps) {
  const mirrorRef = useRef<HTMLDivElement>(null);
  return (
    // The mirror and the input share the same font, padding and box, and the input's own text is
    // transparent, so the coloured runs behind it line up with the caret exactly.
    <div className="relative min-w-0 flex-1">
      <div
        ref={mirrorRef}
        aria-hidden="true"
        data-testid={`${testId}-highlight`}
        className={`pointer-events-none absolute inset-0 overflow-hidden whitespace-pre px-2 ${FIELD_FONT}`}
      >
        {urlSegments(value).map((segment, index) => (
          <span
            key={index}
            data-kind={segment.kind}
            className={
              segment.kind === 'property'
                ? 'text-accent'
                : segment.kind === 'param'
                  ? 'text-status-info'
                  : 'text-fg-default'
            }
          >
            {segment.text}
          </span>
        ))}
      </div>
      <input
        id={id}
        aria-label={ariaLabel}
        data-testid={testId}
        spellCheck={false}
        value={value}
        placeholder={placeholder}
        className={`relative h-row w-full bg-transparent px-2 text-transparent caret-fg-default placeholder:text-fg-faint focus:outline-none ${FIELD_FONT}`}
        onChange={(event) => {
          onChange(event.target.value);
        }}
        onScroll={(event) => {
          // Keep the mirror in step when the text is longer than the field.
          if (mirrorRef.current !== null) {
            mirrorRef.current.scrollLeft = event.currentTarget.scrollLeft;
          }
        }}
        onKeyDown={onKeyDown}
      />
    </div>
  );
}
