import { useRef } from 'react';
import { PALETTES, type Palette } from '@shared/palettes.js';
import { PALETTE_LABEL, type ResolvedTheme } from '../../../lib/theme.js';

/**
 * The tokens each card's five swatches show: the frame, the window, a raised surface, the text and
 * the accent — enough to tell the seven apart at a glance.
 */
const SWATCH_TOKENS = ['--wb-bg-chrome', '--wb-bg-base', '--wb-bg-raised', '--wb-fg-default', '--wb-accent-default'];

export interface PaletteCardsProps {
  readonly value: Palette;
  readonly onChange: (palette: Palette) => void;
  /** The mode the window is in, so every card is drawn as it would look now. */
  readonly mode: ResolvedTheme;
  /** The id of the label that names the group. */
  readonly labelledBy?: string;
  readonly disabled?: boolean;
}

/**
 * Settings → Appearance's colour theme picker: a radio group of seven cards in a wrapping grid,
 * each with its name and five swatches. The arrow keys move the selection, as in any radio group.
 *
 * The swatches are painted by `var(--wb-…)` inside a wrapper carrying the card's `data-palette`
 * and the current `data-theme`, so their colours come from `tokens.css` itself — no colour is
 * restated here — and a card shows its palette whatever the window wears (`tokens.css` gives
 * every `[data-palette]` element Default's base, which is what makes Default's card work too).
 */
export function PaletteCards({ value, onChange, mode, labelledBy, disabled = false }: PaletteCardsProps) {
  const group = useRef<HTMLDivElement>(null);
  const select = (index: number): void => {
    const next = PALETTES[(index + PALETTES.length) % PALETTES.length] ?? 'default';
    if (next !== value) {
      onChange(next);
    }
    group.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[PALETTES.indexOf(next)]?.focus();
  };

  return (
    <div
      ref={group}
      role="radiogroup"
      {...(labelledBy === undefined ? {} : { 'aria-labelledby': labelledBy })}
      {...(disabled ? { 'aria-disabled': true } : {})}
      data-testid="preferences-palette"
      data-value={value}
      className="grid grid-cols-[repeat(auto-fill,minmax(7.5rem,1fr))] gap-2"
    >
      {PALETTES.map((palette, index) => {
        const checked = palette === value;
        return (
          <button
            key={palette}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-label={PALETTE_LABEL[palette]}
            tabIndex={checked ? 0 : -1}
            disabled={disabled}
            data-testid={`preferences-palette-${palette}`}
            onClick={() => {
              if (!checked) {
                onChange(palette);
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
            className={`flex flex-col items-start gap-2 rounded-lg border bg-surface-overlay px-2.5 py-2 text-left focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60 ${
              checked ? 'border-accent ring-1 ring-accent' : 'border-hairline-strong hover:border-fg-faint'
            }`}
          >
            <span data-palette={palette} data-theme={mode} aria-hidden="true" className="flex gap-1">
              {SWATCH_TOKENS.map((token) => (
                <span
                  key={token}
                  data-swatch=""
                  className="h-3.5 w-3.5 rounded-full border border-hairline-strong"
                  style={{ backgroundColor: `var(${token})` }}
                />
              ))}
            </span>
            <span className={`text-sm ${checked ? 'text-fg-default' : 'text-fg-muted'}`}>{PALETTE_LABEL[palette]}</span>
          </button>
        );
      })}
    </div>
  );
}
