/**
 * The request/response editor views, behind their own code-split boundaries.
 *
 * Only one view is mounted at a time — a pane shows XML, Form, Outline, Raw or Query — but
 * importing them statically put all five in the `request-editor` chunk, so opening a request
 * paid for the Form view's schema-driven field rendering and the Query view's XPath UI even
 * though the pane opens on XML. `React.lazy` gives each its own chunk, fetched the first time
 * that tab is selected.
 *
 * The XML view stays static: it is the default view of both panes, so deferring it would only
 * add a round trip to the one view that is always shown.
 */
import { lazy } from 'react';

/**
 * The fallback both panes render while a view chunk is in flight; matches the wording and the
 * markup of `editor-area.tsx`'s own lazy fallback.
 *
 * Deliberately not a `role="status"` live region: each pane already owns one (the response
 * status line), and a second would both fight it for announcements and make `getByRole` in the
 * pane tests ambiguous. A chunk fetch off a local disk is not worth interrupting a reader for.
 */
export function ViewFallback(): React.JSX.Element {
  return <p className="p-4 text-sm text-fg-subtle">Loading view…</p>;
}

/** Schema-driven form editor for the request envelope. */
export const FormView = lazy(async () => {
  const module = await import('./form-view.js');
  return { default: module.FormView };
});

/** Tree outline over an envelope, shared by both panes. */
export const OutlineView = lazy(async () => {
  const module = await import('./outline-view.js');
  return { default: module.OutlineView };
});

/** The raw bytes of a request or response. */
export const RawView = lazy(async () => {
  const module = await import('./raw-view.js');
  return { default: module.RawView };
});

/** XPath/XQuery over the response body. */
export const QueryView = lazy(async () => {
  const module = await import('./query-view.js');
  return { default: module.QueryView };
});

/** SOAP fault summary for the response pane. */
export const FaultOverview = lazy(async () => {
  const module = await import('./fault-overview.js');
  return { default: module.FaultOverview };
});
