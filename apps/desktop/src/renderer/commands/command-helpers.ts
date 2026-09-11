import { useEditorsStore } from '../state/editors.js';
import { useUiStore } from '../state/ui.js';

/** The request draft behind the active editor tab, or `undefined` when none is a request tab. */
export function activeRequestId(): string | undefined {
  const { tabs, activeId } = useEditorsStore.getState();
  return tabs.find((tab) => tab.id === activeId && tab.kind === 'request')?.requestId;
}

/** The UI store's current actions. A function, not a binding: the store is replaced on every set. */
export function ui(): ReturnType<typeof useUiStore.getState> {
  return useUiStore.getState();
}

/** True when a request tab is active — the `when` gate every `request.*`/`editor.*` command shares. */
export function hasActiveRequest(): boolean {
  return activeRequestId() !== undefined;
}

/** Wraps a handler so it only runs with the active request's id, and is a no-op without one. */
export function onActiveRequest(run: (requestId: string) => void): () => void {
  return () => {
    const requestId = activeRequestId();
    if (requestId !== undefined) {
      run(requestId);
    }
  };
}
