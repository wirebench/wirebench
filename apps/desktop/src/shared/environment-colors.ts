/**
 * The colours an environment can carry (#345): a palette name, drawn in a theme-aware shade, or a
 * `#rrggbb` the user picked. No zod here, so the renderer may import it eagerly.
 */

export const ENVIRONMENT_PALETTE = ['red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'grey'] as const;
export type EnvironmentPaletteName = (typeof ENVIRONMENT_PALETTE)[number];

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/** True for a palette name or a `#rrggbb` value: what the editor may write. */
export function isEnvironmentColor(value: string): boolean {
  return HEX_COLOR.test(value) || (ENVIRONMENT_PALETTE as readonly string[]).includes(value);
}

/**
 * The CSS colour an environment's `color` draws in: a palette name's theme token, a `#rrggbb` as
 * written, nothing for no colour or one this build does not know.
 */
export function environmentColorCss(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (HEX_COLOR.test(value)) return value;
  return (ENVIRONMENT_PALETTE as readonly string[]).includes(value) ? `var(--wb-env-${value})` : undefined;
}
