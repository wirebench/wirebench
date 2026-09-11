/**
 * The request/response editor views, behind their own code-split boundaries.
 *
 * Only one view is mounted at a time — a pane shows XML, Form, Outline, Raw or Query — but
 * importing them statically put all five in the `request-editor` chunk, so opening a request
 * paid for the Form view's schema-driven field rendering and the Query view's XPath UI even
 * though the pane opens on XML. Splitting them gives each its own chunk.
 *
 * The XML view stays static: it is the default view of both panes, so deferring it would only
 * add a round trip to the one view that is always shown.
 *
 * ## Why not `React.lazy`
 *
 * `React.lazy` made the first click on a view tab measurably slower — +285 ms for Outline and
 * +325 ms for Query over a 1 MB response, against a 54 kB saving in the `request-editor` chunk.
 * Warming the module with a plain `import()` did not help: a `lazy` component suspends on its
 * first render whatever the module map already holds, and it is the fallback commit plus the
 * re-render after it that costs the time.
 *
 * So {@link splitView} keeps the dynamic `import()` — Rollup still emits a separate chunk — but
 * resolves it into a module-level slot. Once {@link prefetchViews} has run (both panes start it
 * on mount), the component renders synchronously, with no suspend and no extra commit. If a tab
 * is somehow clicked before that finishes it suspends exactly like `React.lazy`, and the
 * `Suspense` boundary in each pane covers it.
 *
 * Every split view is also wrapped in {@link ViewErrorBoundary}, so a chunk that fails to load
 * shows a retryable message in the pane instead of blanking it.
 */
import { Component, type ComponentType, type ErrorInfo, type ReactNode } from 'react';
import type { FormViewProps } from './form-view.js';
import type { OutlineViewProps } from './outline-view.js';
import type { RawViewProps } from './raw-view.js';
import type { QueryViewProps } from './query-view.js';
import type { FaultOverviewProps } from './fault-overview.js';

/** A code-split view: the component to render, plus the warm-up that removes its first-render cost. */
interface SplitView<P> {
  readonly Component: ComponentType<P>;
  readonly prefetch: () => void;
}

/** Props of {@link ViewErrorBoundary}. */
interface ViewErrorBoundaryProps {
  /** Clears the failed chunk's cache so the next render re-imports it. */
  readonly onRetry: () => void;
  readonly children: ReactNode;
}

/**
 * The inline fallback for a view whose chunk could not be loaded — an offline update, a
 * half-written install, a transient file-system error. Without it a failed `import()` leaves the
 * pane blank forever (React unmounts the subtree it could not render) and, when the failure is
 * re-thrown from every render, retries it in a loop.
 *
 * Kept deliberately small: a sentence and a Retry button, in the pane where the view would have
 * been, so the rest of the app — the request, the response, the other tabs — stays usable.
 */
class ViewErrorBoundary extends Component<ViewErrorBoundaryProps, { readonly failed: boolean }> {
  constructor(props: ViewErrorBoundaryProps) {
    super(props);
    this.state = { failed: false };
  }

  static getDerivedStateFromError(): { readonly failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // The renderer has no logger of its own; the console is where a user is asked to look when
    // reporting this, and it is the only record of which chunk failed.
    console.error('Wirebench: a view chunk failed to load', error, info.componentStack);
  }

  private readonly retry = (): void => {
    this.props.onRetry();
    this.setState({ failed: false });
  };

  override render(): ReactNode {
    if (!this.state.failed) {
      return this.props.children;
    }
    return (
      <div className="flex flex-col items-start gap-2 p-4 text-sm text-fg-subtle">
        <p>Could not load this view.</p>
        <button
          type="button"
          className="rounded border border-hairline px-2 py-1 text-fg-default hover:bg-surface-raised"
          onClick={this.retry}
        >
          Retry
        </button>
      </div>
    );
  }
}

/**
 * Wraps a dynamic import as a component that suspends only until the chunk has loaded once, and
 * renders synchronously ever after.
 *
 * A rejected import is remembered as an `Error` rather than re-attempted on every render: the
 * next render throws it (a real `Error`, so {@link ViewErrorBoundary} catches it instead of
 * treating it as another suspension), and only the boundary's Retry clears both caches and
 * starts a fresh import.
 *
 * Exported for `test/renderer/lazy-views.test.tsx`, which drives it with a rejecting loader.
 */
export function splitView<P extends object>(load: () => Promise<ComponentType<P>>): SplitView<P> {
  let loaded: ComponentType<P> | undefined;
  let pending: Promise<void> | undefined;
  let failure: Error | undefined;

  const start = (): Promise<void> => {
    pending ??= load().then(
      (component) => {
        loaded = component;
      },
      (cause: unknown) => {
        // Resolved, not rejected: the throw-a-promise contract only retries the render once the
        // promise settles, and the retried render is where `failure` is thrown as an Error.
        failure = cause instanceof Error ? cause : new Error(String(cause));
      },
    );
    return pending;
  };

  const reset = (): void => {
    loaded = undefined;
    pending = undefined;
    failure = undefined;
  };

  function Split(props: P): React.JSX.Element {
    if (failure !== undefined) {
      throw failure;
    }
    if (loaded === undefined) {
      // Throwing a promise is the same Suspense contract React's own `lazy` uses: the nearest
      // boundary shows its fallback and retries once the promise settles. It is the one place a
      // non-Error throw is correct, so the rule is turned off for this statement alone.
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- Suspense's contract is to throw the pending promise itself
      throw start();
    }
    const Loaded = loaded;
    return <Loaded {...props} />;
  }

  function Guarded(props: P): React.JSX.Element {
    return (
      <ViewErrorBoundary onRetry={reset}>
        <Split {...props} />
      </ViewErrorBoundary>
    );
  }

  return {
    Component: Guarded,
    prefetch: () => {
      // A failure here is not surfaced: this is an optimisation, and the same failure is shown
      // properly by the boundary above if and when the user selects that view.
      void start();
    },
  };
}

const form = splitView<FormViewProps>(async () => (await import('./form-view.js')).FormView);
const outline = splitView<OutlineViewProps>(async () => (await import('./outline-view.js')).OutlineView);
const raw = splitView<RawViewProps>(async () => (await import('./raw-view.js')).RawView);
const query = splitView<QueryViewProps>(async () => (await import('./query-view.js')).QueryView);
const fault = splitView<FaultOverviewProps>(async () => (await import('./fault-overview.js')).FaultOverview);

/** Schema-driven form editor for the request envelope. */
export const FormView = form.Component;
/** Tree outline over an envelope, shared by both panes. */
export const OutlineView = outline.Component;
/** The raw bytes of a request or response. */
export const RawView = raw.Component;
/** XPath/XQuery over the response body. */
export const QueryView = query.Component;
/** SOAP fault summary for the response pane. */
export const FaultOverview = fault.Component;

/**
 * The fallback both panes render while a view chunk is in flight; matches the wording and the
 * markup of `editor-area.tsx`'s own lazy fallback. In practice it is never seen, because
 * {@link prefetchViews} resolves every chunk long before a tab can be clicked.
 *
 * Deliberately not a `role="status"` live region: each pane already owns one (the response
 * status line), and a second would both fight it for announcements and make `getByRole` in the
 * pane tests ambiguous.
 */
export function ViewFallback(): React.JSX.Element {
  return <p className="p-4 text-sm text-fg-subtle">Loading view…</p>;
}

/**
 * Loads every view chunk. Both panes call this on mount; it is idempotent, and each chunk is
 * fetched at most once per session.
 */
export function prefetchViews(): void {
  form.prefetch();
  outline.prefetch();
  raw.prefetch();
  query.prefetch();
  fault.prefetch();
}
