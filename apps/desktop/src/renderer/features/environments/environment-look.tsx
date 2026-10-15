import { useState } from 'react';
import { ENVIRONMENT_PALETTE, environmentColorCss, isEnvironmentColor } from '../../../shared/environment-colors.js';

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

const SWATCH_CLASS =
  'size-4 shrink-0 rounded-full border border-hairline outline-none focus-visible:ring-2 focus-visible:ring-accent aria-pressed:ring-2 aria-pressed:ring-fg-default';

/**
 * An environment's colour (#345): the palette as swatches, "No colour", and a custom `#rrggbb`
 * field committed on Enter or blur. Shown in the environment details panel.
 */
export function EnvironmentColour({
  name,
  color,
  onColor,
}: {
  readonly name: string;
  readonly color: string | undefined;
  /** `null` takes the colour off. */
  readonly onColor: (color: string | null) => void;
}) {
  const custom = color !== undefined && HEX_COLOR.test(color) ? color : '';
  const [draft, setDraft] = useState(custom);
  const [shown, setShown] = useState(custom);
  // A colour changed elsewhere (another window, an undo) replaces what the field shows.
  if (shown !== custom) {
    setShown(custom);
    setDraft(custom);
  }
  const commit = (): void => {
    const value = draft.trim();
    if (value === custom) return;
    if (HEX_COLOR.test(value) && isEnvironmentColor(value)) {
      onColor(value);
    } else {
      setDraft(custom);
    }
  };

  return (
    <div
      role="group"
      aria-label={`Colour of ${name}`}
      data-testid="environment-look"
      className="flex flex-wrap items-center gap-1.5"
    >
      {ENVIRONMENT_PALETTE.map((swatch) => (
        <button
          key={swatch}
          type="button"
          aria-label={`Colour ${swatch}`}
          aria-pressed={color === swatch}
          className={`${SWATCH_CLASS} bg-[var(--env-color)]`}
          style={{ '--env-color': environmentColorCss(swatch) } as React.CSSProperties}
          onClick={() => {
            if (color !== swatch) onColor(swatch);
          }}
        />
      ))}
      <button
        type="button"
        aria-label="No colour"
        aria-pressed={color === undefined}
        className="rounded px-1 text-xs text-fg-muted hover:text-fg-default aria-pressed:text-fg-default"
        onClick={() => {
          if (color !== undefined) onColor(null);
        }}
      >
        None
      </button>
      <input
        type="text"
        aria-label="Custom colour"
        placeholder="#rrggbb"
        spellCheck={false}
        maxLength={7}
        value={draft}
        className="h-row w-20 rounded border border-hairline bg-surface-sunken px-1.5 font-mono text-xs text-fg-default"
        onChange={(event) => {
          setDraft(event.target.value);
        }}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') commit();
          if (event.key === 'Escape') setDraft(custom);
        }}
      />
    </div>
  );
}
