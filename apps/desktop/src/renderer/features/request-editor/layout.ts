/**
 * How a request editor arranges its two panes.
 *
 * The *default* lives in `preferences.ui.defaultLayout` (mirrored into the `ui` store, which
 * is what renders); a per-request *override* lives in the `editors` store (session only, never
 * saved to the project). Toggling from the toolbar or the palette writes both: the override so
 * the flip is scoped to the request being looked at, and the default so the next request — and
 * the next launch — starts the way the user last left it.
 */

import { useEditorsStore } from '../../state/editors.js';
import { usePreferencesStore } from '../../state/preferences.js';
import { useUiStore } from '../../state/ui.js';

/** Where the response pane sits, and whether both panes are visible at once. */
export interface EditorLayout {
  /** `side-by-side` puts request left, response right; `stacked` puts response underneath. */
  readonly orientation: 'side-by-side' | 'stacked';
  /** `split` shows both panes; `tabs` shows one at a time behind a Request/Response strip. */
  readonly mode: 'split' | 'tabs';
}

/** What a first run (and any request without an override) gets. */
export const DEFAULT_EDITOR_LAYOUT: EditorLayout = { orientation: 'side-by-side', mode: 'split' };

/** The `react-resizable-panels` orientation for a layout. */
export function groupOrientation(layout: EditorLayout): 'horizontal' | 'vertical' {
  return layout.orientation === 'side-by-side' ? 'horizontal' : 'vertical';
}

/** The same layout with its orientation flipped. */
export function flipOrientation(layout: EditorLayout): EditorLayout {
  return { ...layout, orientation: layout.orientation === 'side-by-side' ? 'stacked' : 'side-by-side' };
}

/** The same layout with its split/tabs mode flipped. */
export function flipMode(layout: EditorLayout): EditorLayout {
  return { ...layout, mode: layout.mode === 'split' ? 'tabs' : 'split' };
}

/** Reads the layout in force for `requestId`: its override, else the persisted default. */
export function useEditorLayout(requestId: string): EditorLayout {
  const override = useEditorsStore((state) => state.editorLayouts[requestId]);
  const fallback = useUiStore((state) => state.editorLayout);
  return override ?? fallback;
}

/** The layout in force for `requestId`, read outside React (commands, event handlers). */
export function editorLayoutFor(requestId: string): EditorLayout {
  return useEditorsStore.getState().editorLayouts[requestId] ?? useUiStore.getState().editorLayout;
}

/**
 * Applies `change` to `requestId`'s layout, recording it both as that request's override and
 * as the new persisted default (see this module's header for why both).
 */
export function setEditorLayout(requestId: string, change: (layout: EditorLayout) => EditorLayout): EditorLayout {
  const next = change(editorLayoutFor(requestId));
  useEditorsStore.getState().setEditorLayout(requestId, next);
  // The ui store is the render-time mirror; `preferences.ui.defaultLayout` is what actually
  // persists (and what the preferences mirror pushes back down on the next launch).
  useUiStore.getState().setEditorLayout(next);
  void usePreferencesStore.getState().update({ ui: { defaultLayout: next } });
  return next;
}
