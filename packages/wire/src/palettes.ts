/**
 * The colour themes a window can wear, beside its mode (`ui.theme`). Kept free of zod so the
 * renderer can import the list at start-up without compiling a validator (its CSP forbids the
 * `new Function` probe zod runs). `wire-base.ts` re-exports it for the wire schema; the engine's
 * preferences model restates it, and `preferences-defaults.test.ts` keeps the two equal.
 */
export const PALETTES = [
  'default',
  'field-kit',
  'sandstone',
  'dusk',
  'seed',
  'pith',
  'rind',
  'plume',
  'kiln',
  'trail',
] as const;

/** One of {@link PALETTES}; `default` puts no `data-palette` on the document. */
export type Palette = (typeof PALETTES)[number];
