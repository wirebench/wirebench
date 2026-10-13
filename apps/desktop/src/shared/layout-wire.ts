import { z } from 'zod';
import { SSH_MAX_PANES } from './ssh-defaults.js';

/**
 * Wire shapes of saved terminal layouts (SSH area, panes slice 3): `userData/ssh-layouts.json`, kept per
 * machine and per workspace by main. Hosts are named by id only. The renderer imports this file for its types
 * only (the CSP trap: no eager value import); the pane limit it needs is in `ssh-defaults.ts`.
 */

export type LayoutNodeWire =
  | { kind: 'pane'; host: string }
  | { kind: 'split'; dir: 'row' | 'column'; ratio: number; a: LayoutNodeWire; b: LayoutNodeWire };

const nodeSchema: z.ZodType<LayoutNodeWire> = z.lazy(() =>
  z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('pane'), host: z.string().min(1) }),
    z.strictObject({
      kind: z.literal('split'),
      dir: z.enum(['row', 'column']),
      ratio: z.number().min(0.1).max(0.9),
      a: nodeSchema,
      b: nodeSchema,
    }),
  ]),
);

/** How many panes `node` holds. */
export function paneCount(node: LayoutNodeWire): number {
  return node.kind === 'pane' ? 1 : paneCount(node.a) + paneCount(node.b);
}

/** A layout tree: well formed, and no more panes than a tab holds. */
export const layoutNodeWireSchema = nodeSchema.refine((node) => paneCount(node) <= SSH_MAX_PANES, {
  message: `A layout holds at most ${String(SSH_MAX_PANES)} panes`,
});

export const layoutWireSchema = z.strictObject({
  id: z.string().min(1),
  name: z.string(),
  root: layoutNodeWireSchema,
});

export interface LayoutWire {
  id: string;
  name: string;
  root: LayoutNodeWire;
}

export const layoutsFileSchema = z.strictObject({
  version: z.literal(1),
  workspaces: z.record(z.string(), z.array(layoutWireSchema)),
});

export const layoutListResponseSchema = z.object({ layouts: z.array(layoutWireSchema) });

/** No `id` creates a layout; an `id` replaces that layout's name and tree. */
export const layoutSaveRequestSchema = z.strictObject({
  id: z.string().optional(),
  name: z.string(),
  // The store checks the tree, so a bad one is `ssh-layout-invalid` rather than a malformed request.
  root: z.unknown(),
});

export const layoutSaveResponseSchema = z.object({ layout: layoutWireSchema });

export const layoutRenameRequestSchema = z.strictObject({ id: z.string(), name: z.string() });

export const layoutDeleteRequestSchema = z.strictObject({ id: z.string() });

export type LayoutListResponse = z.infer<typeof layoutListResponseSchema>;
